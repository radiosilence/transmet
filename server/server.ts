/**
 * Serves the reader and its pages to a signed-in browser.
 *
 * There are two ways in, and both end in the same cookie: single sign-on
 * through the estate's OIDC provider, when one is configured, and a shared
 * password that works whether or not the provider is up. The provider admits
 * only the GitHub logins on its own allowlist, so any subject it issues a token
 * for is someone allowed to read.
 *
 * The session is a cookie holding an HMAC of a fixed label keyed by the
 * password, so there is no session store, every replica agrees, and rotating
 * the password signs everyone out. It is long-lived because the service worker
 * refetches pages in the background, where no login form can be shown.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join, normalize, sep } from "node:path";

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const password = env("TRANSMET_PASSWORD");
const oidc = process.env.OIDC_ISSUER
  ? {
      issuer: process.env.OIDC_ISSUER,
      clientId: env("OIDC_CLIENT_ID"),
      clientSecret: env("OIDC_CLIENT_SECRET"),
      redirectUri: `${env("PUBLIC_URL")}/auth/callback`,
    }
  : undefined;

const port = Number(process.env.PORT ?? 3000);
const webDir = process.env.WEB_DIR ?? "/app/web";
const pagesDir = process.env.PAGES_DIR ?? "/pages";

const COOKIE = "transmet";
const MAX_AGE = 400 * 24 * 60 * 60;
const token = new Bun.CryptoHasher("sha256", password)
  .update("transmet-session-v1")
  .digest("hex");
const SESSION = `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;

/**
 * The state and PKCE verifier of a sign-in in flight. Lax, because the
 * provider's redirect back is a cross-site top-level navigation.
 */
const FLOW = "transmet-flow";
const FLOW_ATTRS = "Path=/auth; HttpOnly; Secure; SameSite=Lax";

/** Paths a browser fetches for the home-screen icon before anyone logs in. */
const PUBLIC = new Set([
  "/_health",
  "/login",
  "/auth/login",
  "/auth/callback",
  "/app.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
]);

const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

const ERRORS: Record<string, string> = {
  "1": "Wrong. Try again.",
  sso: "GitHub sign-in failed.",
};

function cookie(req: Request, name: string) {
  return (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function authed(req: Request) {
  const value = cookie(req, COOKIE);
  if (!value || value.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

/** Resolves a request path under `root`, refusing anything that climbs out. */
function under(root: string, path: string) {
  const resolved = normalize(join(root, decodeURIComponent(path)));
  return resolved.startsWith(root + sep) ? resolved : null;
}

async function file(path: string | null, cacheControl: string) {
  if (!path) return null;
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  return new Response(f, { headers: { "cache-control": cacheControl } });
}

function loginPage(error: string | null) {
  const html = LOGIN_HTML.replace("{{error}}", (error && ERRORS[error]) ?? "")
    .replace("{{sso}}", oidc ? SSO_HTML : "")
    // A focused field raises the phone keyboard over the button most visits use.
    .replace("{{autofocus}}", oidc ? "" : "autofocus");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE },
  });
}

function redirect(location: string, cookies: string[] = []) {
  return new Response(null, {
    status: 303,
    headers: [["location", location], ...cookies.map((c) => ["set-cookie", c] as [string, string])],
  });
}

/**
 * Exchanges the code for the subject it was issued to, or null.
 *
 * The id_token comes straight back from the issuer over TLS in answer to a
 * request made here, so there is no untrusted party for a signature check to
 * catch. Only the subject is read; nothing is kept.
 */
async function exchange(code: string, verifier: string) {
  if (!oidc) return null;
  const res = await fetch(`${oidc.issuer}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidc.redirectUri,
      client_id: oidc.clientId,
      client_secret: oidc.clientSecret,
      code_verifier: verifier,
    }),
  }).catch((e: unknown) => {
    console.warn(`token endpoint unreachable: ${e}`);
    return null;
  });
  // The body is never logged: it can carry token material.
  if (!res?.ok) {
    if (res) console.warn(`token endpoint returned ${res.status}`);
    return null;
  }
  const { id_token } = (await res.json()) as { id_token?: string };
  const payload = id_token?.split(".")[1];
  if (!payload) return null;
  const { sub } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string };
  return sub || null;
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/_health") return new Response("ok");

    if (path === "/login") {
      if (req.method === "POST") {
        const form = await req.formData();
        const given = String(form.get("password") ?? "");
        const ok =
          given.length === password.length &&
          timingSafeEqual(Buffer.from(given), Buffer.from(password));
        if (!ok) {
          await Bun.sleep(1000);
          return redirect("/login?e=1");
        }
        return redirect("/", [SESSION]);
      }
      return loginPage(url.searchParams.get("e"));
    }

    if (path.startsWith("/auth/") && !oidc) return redirect("/login");

    if (path === "/auth/login" && oidc) {
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(`${oidc.issuer}/oauth2/auth`);
      authorize.search = new URLSearchParams({
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUri,
        response_type: "code",
        scope: "openid",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return redirect(authorize.href, [`${FLOW}=${state}.${verifier}; Max-Age=600; ${FLOW_ATTRS}`]);
    }

    if (path === "/auth/callback" && oidc) {
      const [state, verifier] = (cookie(req, FLOW) ?? "").split(".");
      const code = url.searchParams.get("code");
      const sub =
        state && verifier && code && url.searchParams.get("state") === state
          ? await exchange(code, verifier)
          : null;
      const clear = `${FLOW}=; Max-Age=0; ${FLOW_ATTRS}`;
      return sub ? redirect("/", [clear, SESSION]) : redirect("/login?e=sso", [clear]);
    }

    if (!PUBLIC.has(path) && !authed(req)) {
      const navigating = req.headers.get("sec-fetch-mode") === "navigate";
      return navigating ? redirect("/login") : new Response("unauthorised", { status: 401 });
    }

    if (path.startsWith("/pages/")) {
      const rel = path.slice("/pages".length);
      const cache = rel === "/manifest.json" ? REVALIDATE : IMMUTABLE;
      return (
        (await file(under(pagesDir, rel), cache)) ??
        new Response("not found", { status: 404 })
      );
    }

    const cache = path.startsWith("/assets/") ? IMMUTABLE : REVALIDATE;
    return (
      (await file(path === "/" ? null : under(webDir, path), cache)) ??
      (await file(join(webDir, "index.html"), REVALIDATE))!
    );
  },
});

console.log(`transmet listening on :${port}${oidc ? `, signing in through ${oidc.issuer}` : ""}`);

const SSO_HTML = `<a class="sso" href="/auth/login">Sign in with GitHub</a>
  <p class="or">or</p>`;

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0b0a">
<title>Transmet</title>
<link rel="manifest" href="/app.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  :root { color-scheme: dark; --ink: #0b0b0a; --paper: #f1ede4; --acid: #c6ff1a; --hot: #ff2e4c; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: var(--ink); color: var(--paper); }
  body {
    font: 500 16px/1.4 ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif;
    display: grid; place-items: center; padding: 24px;
    padding-bottom: max(24px, env(safe-area-inset-bottom));
  }
  form { width: min(100%, 340px); display: grid; gap: 14px; }
  h1 {
    font: 900 clamp(44px, 14vw, 64px)/0.85 "Arial Narrow", "Helvetica Neue Condensed", ui-sans-serif, sans-serif;
    font-stretch: condensed; letter-spacing: -0.02em; text-transform: uppercase;
  }
  h1 span { color: var(--acid); }
  p { color: #8d8a82; font-size: 14px; }
  input, button {
    font: inherit; border-radius: 12px; padding: 15px 16px; border: 1px solid #2a2926;
    width: 100%; background: #151513; color: var(--paper);
  }
  input:focus { outline: 2px solid var(--acid); outline-offset: 1px; }
  button { background: var(--acid); color: var(--ink); border: 0; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
  .err { color: var(--hot); min-height: 1.4em; font-size: 14px; }
  .sso {
    display: block; text-align: center; text-decoration: none; border-radius: 12px; padding: 15px 16px;
    background: var(--acid); color: var(--ink); font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .or { text-align: center; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Trans<br><span>met</span></h1>
  <p>The city is waiting.</p>
  {{sso}}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" {{autofocus}} required>
  <button type="submit">Enter</button>
  <div class="err">{{error}}</div>
</form>
</body>
</html>`;
