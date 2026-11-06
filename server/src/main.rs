//! Serves the reader and its pages to a signed-in browser.
//!
//! There are two ways in, and both end in the same cookie: single sign-on
//! through the estate's OIDC provider, when one is configured, and a shared
//! password that works whether or not the provider is up. The provider admits
//! only the GitHub logins on its own allowlist, so any subject it issues a token
//! for is someone allowed to read.
//!
//! The session is a cookie holding an HMAC of a fixed label keyed by the
//! password, so there is no session store, every replica agrees, and rotating
//! the password signs everyone out. It is long-lived because the service worker
//! refetches pages in the background, where no login form can be shown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Form, FromRequest, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tower::ServiceExt;
use tower_http::services::ServeFile;

const COOKIE: &str = "transmet";
const MAX_AGE: u64 = 400 * 24 * 60 * 60;

/// The state and PKCE verifier of a sign-in in flight. Lax, because the
/// provider's redirect back is a cross-site top-level navigation.
const FLOW: &str = "transmet-flow";
const FLOW_ATTRS: &str = "Path=/auth; HttpOnly; Secure; SameSite=Lax";

/// Paths a browser fetches for the home-screen icon before anyone logs in.
const PUBLIC: &[&str] = &[
    "/_health",
    "/login",
    "/auth/login",
    "/auth/callback",
    "/app.webmanifest",
    "/icon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/apple-touch-icon.png",
];

const IMMUTABLE: &str = "private, max-age=31536000, immutable";
const REVALIDATE: &str = "no-cache";

const LOGIN_HTML: &str = include_str!("../login.html");
const SSO_HTML: &str = r#"<a class="sso" href="/auth/login">Sign in with GitHub</a>
  <p class="or">or</p>"#;

/// Lenient about padding, as id_token segments arrive without it.
const B64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

struct Oidc {
    issuer: String,
    /// Parsed at startup, so a malformed issuer stops the server there rather
    /// than on the first sign-in.
    authorize: url::Url,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    /// The token exchange is server to server, so it can reach the provider
    /// inside the cluster rather than back out through its public hostname.
    token_url: String,
}

struct App {
    password: String,
    token: String,
    session: String,
    oidc: Option<Oidc>,
    web_dir: PathBuf,
    pages_dir: PathBuf,
    http: reqwest::Client,
}

fn env(name: &str) -> String {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v,
        _ => panic!("{name} is required"),
    }
}

fn session_token(password: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(password.as_bytes()).expect("any key length");
    mac.update(b"transmet-session-v1");
    hex::encode(mac.finalize().into_bytes())
}

fn random_b64url() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system randomness");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim_start)
        .find_map(|c| c.strip_prefix(name)?.strip_prefix('='))
}

/// Resolves a request path under `root`, refusing anything that climbs out or
/// names the root itself.
fn under(root: &Path, path: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?;
    let mut resolved = root.to_path_buf();
    let mut depth = 0;
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p if p.contains('\0') => return None,
            p => {
                resolved.push(p);
                depth += 1;
            }
        }
    }
    (depth > 0).then_some(resolved)
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file())
}

async fn serve(req: Request, path: PathBuf, cache_control: &'static str) -> Response {
    let mut res = ServeFile::new(path)
        .oneshot(req)
        .await
        .expect("infallible")
        .map(Body::new);
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    res
}

fn login_page(app: &App, error: Option<&str>) -> Response {
    let error = match error {
        Some("1") => "Wrong. Try again.",
        Some("sso") => "GitHub sign-in failed.",
        _ => "",
    };
    let sso = app.oidc.is_some();
    let html = LOGIN_HTML
        .replace("{{error}}", error)
        .replace("{{sso}}", if sso { SSO_HTML } else { "" })
        // A focused field raises the phone keyboard over the button most visits use.
        .replace("{{autofocus}}", if sso { "" } else { "autofocus" });
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, REVALIDATE),
        ],
        html,
    )
        .into_response()
}

fn redirect(location: &str, cookies: &[&str]) -> Response {
    let mut res = Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, location);
    for c in cookies {
        res = res.header(header::SET_COOKIE, *c);
    }
    res.body(Body::empty()).expect("valid redirect")
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct Claims {
    sub: Option<String>,
}

/// Exchanges the code for the subject it was issued to, or None.
///
/// The id_token comes straight back from the issuer over TLS in answer to a
/// request made here, so there is no untrusted party for a signature check to
/// catch. Only the subject is read; nothing is kept.
async fn exchange(app: &App, oidc: &Oidc, code: &str, verifier: &str) -> Option<String> {
    let res = app
        .http
        .post(&oidc.token_url)
        // Hydra serves plain HTTP in-cluster and trusts a proxy's word that the
        // client connection was TLS.
        .header("x-forwarded-proto", "https")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &oidc.redirect_uri),
            ("client_id", &oidc.client_id),
            ("client_secret", &oidc.client_secret),
            ("code_verifier", verifier),
        ])
        .send()
        .await;
    // The body is never logged: it can carry token material.
    let res = match res {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            eprintln!("token endpoint returned {}", r.status().as_u16());
            return None;
        }
        Err(e) => {
            eprintln!("token endpoint unreachable: {e}");
            return None;
        }
    };
    let id_token = res.json::<TokenResponse>().await.ok()?.id_token?;
    let payload = B64URL.decode(id_token.split('.').nth(1)?).ok()?;
    serde_json::from_slice::<Claims>(&payload)
        .ok()?
        .sub
        .filter(|s| !s.is_empty())
}

async fn handle(State(app): State<Arc<App>>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    // The first of a repeated parameter wins, as URLSearchParams.get had it.
    let mut query = HashMap::new();
    for (k, v) in url::form_urlencoded::parse(req.uri().query().unwrap_or_default().as_bytes()) {
        query
            .entry(k.into_owned())
            .or_insert_with(|| v.into_owned());
    }

    if path == "/_health" {
        return "ok".into_response();
    }

    if path == "/login" {
        if req.method() == Method::POST {
            #[derive(Deserialize)]
            struct Login {
                password: Option<String>,
            }
            let given = match Form::<Login>::from_request(req, &()).await {
                Ok(Form(l)) => l.password.unwrap_or_default(),
                Err(_) => String::new(),
            };
            if !constant_eq(&given, &app.password) {
                tokio::time::sleep(Duration::from_secs(1)).await;
                return redirect("/login?e=1", &[]);
            }
            return redirect("/", &[&app.session]);
        }
        return login_page(&app, query.get("e").map(String::as_str));
    }

    if path.starts_with("/auth/") && app.oidc.is_none() {
        return redirect("/login", &[]);
    }

    if let Some(oidc) = &app.oidc {
        if path == "/auth/login" {
            let state = random_b64url();
            let verifier = random_b64url();
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let mut authorize = oidc.authorize.clone();
            authorize
                .query_pairs_mut()
                .append_pair("client_id", &oidc.client_id)
                .append_pair("redirect_uri", &oidc.redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", "openid")
                .append_pair("state", &state)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256");
            let flow = format!("{FLOW}={state}.{verifier}; Max-Age=600; {FLOW_ATTRS}");
            return redirect(authorize.as_str(), &[&flow]);
        }

        if path == "/auth/callback" {
            let mut flow = cookie(req.headers(), FLOW).unwrap_or_default().split('.');
            let (state, verifier) = (
                flow.next().unwrap_or_default(),
                flow.next().unwrap_or_default(),
            );
            let sub = match query.get("code") {
                Some(code)
                    if !state.is_empty()
                        && !verifier.is_empty()
                        && !code.is_empty()
                        && query.get("state").map(String::as_str) == Some(state) =>
                {
                    exchange(&app, oidc, code, verifier).await
                }
                _ => None,
            };
            let clear = format!("{FLOW}=; Max-Age=0; {FLOW_ATTRS}");
            return match sub {
                Some(_) => redirect("/", &[&clear, &app.session]),
                None => redirect("/login?e=sso", &[&clear]),
            };
        }
    }

    let authed = cookie(req.headers(), COOKIE).is_some_and(|v| constant_eq(v, &app.token));
    if !PUBLIC.contains(&path.as_str()) && !authed {
        let navigating = req
            .headers()
            .get("sec-fetch-mode")
            .is_some_and(|v| v == "navigate");
        return if navigating {
            redirect("/login", &[])
        } else {
            (StatusCode::UNAUTHORIZED, "unauthorised").into_response()
        };
    }

    if let Some(rel) = path.strip_prefix("/pages/") {
        // Transcripts can be regenerated under the same name; images cannot.
        let cache = if rel.ends_with(".json") {
            REVALIDATE
        } else {
            IMMUTABLE
        };
        return match under(&app.pages_dir, rel) {
            Some(p) if is_file(&p).await => serve(req, p, cache).await,
            _ => (StatusCode::NOT_FOUND, "not found").into_response(),
        };
    }

    let cache = if path.starts_with("/assets/") {
        IMMUTABLE
    } else {
        REVALIDATE
    };
    let target = if path == "/" {
        None
    } else {
        under(&app.web_dir, &path)
    };
    if let Some(p) = target
        && is_file(&p).await
    {
        return serve(req, p, cache).await;
    }
    let index = app.web_dir.join("index.html");
    if is_file(&index).await {
        serve(req, index, REVALIDATE).await
    } else {
        (StatusCode::NOT_FOUND, "not found").into_response()
    }
}

async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[tokio::main]
async fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("no other TLS provider installed");
    let password = env("TRANSMET_PASSWORD");
    let oidc = std::env::var("OIDC_ISSUER")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|issuer| Oidc {
            authorize: url::Url::parse(&format!("{issuer}/oauth2/auth"))
                .unwrap_or_else(|e| panic!("OIDC_ISSUER is not a URL: {e}")),
            client_id: env("OIDC_CLIENT_ID"),
            client_secret: env("OIDC_CLIENT_SECRET"),
            redirect_uri: format!("{}/auth/callback", env("PUBLIC_URL")),
            token_url: std::env::var("OIDC_TOKEN_URL")
                .unwrap_or_else(|_| format!("{issuer}/oauth2/token")),
            issuer,
        });
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let dir = |name: &str, default: &str| {
        PathBuf::from(std::env::var(name).unwrap_or_else(|_| default.into()))
    };

    let token = session_token(&password);
    let app = Arc::new(App {
        session: format!(
            "{COOKIE}={token}; Path=/; Max-Age={MAX_AGE}; HttpOnly; Secure; SameSite=Lax"
        ),
        token,
        password,
        web_dir: dir("WEB_DIR", "/app/web"),
        pages_dir: dir("PAGES_DIR", "/pages"),
        // Short enough that an unreachable provider sends the browser back to
        // the login page rather than leaving it hanging.
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .expect("HTTP client"),
        oidc,
    });

    match &app.oidc {
        Some(o) => println!(
            "transmet listening on :{port}, signing in through {}",
            o.issuer
        ),
        None => println!("transmet listening on :{port}"),
    }

    let router = Router::new().fallback(handle).with_state(app);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_token_keeps_existing_cookies_valid() {
        assert_eq!(
            session_token("test"),
            "be6b2bc454d8592c03552956f1519f98b3401a3b4872a32245269f712d2c92ee"
        );
    }

    #[test]
    fn under_refuses_escapes_and_the_root() {
        let root = Path::new("/pages");
        assert_eq!(
            under(root, "1/001.jpg"),
            Some(PathBuf::from("/pages/1/001.jpg"))
        );
        assert_eq!(
            under(root, "/1/%30%30%31.jpg"),
            Some(PathBuf::from("/pages/1/001.jpg"))
        );
        assert_eq!(under(root, "../etc/passwd"), None);
        assert_eq!(under(root, "1/%2e%2e/%2e%2e/etc"), None);
        assert_eq!(under(root, "1/..%2F..%2Fetc"), None);
        assert_eq!(under(root, "/"), None);
        assert_eq!(under(root, ""), None);
    }

    #[test]
    fn cookie_finds_the_named_one() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("transmet-flow=a.b; transmet=xyz"),
        );
        assert_eq!(cookie(&h, "transmet"), Some("xyz"));
        assert_eq!(cookie(&h, "transmet-flow"), Some("a.b"));
        assert_eq!(cookie(&h, "other"), None);
    }
}
