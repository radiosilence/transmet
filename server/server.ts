/**
 * Serves the reader and its pages behind a single shared password.
 *
 * The session is a cookie holding an HMAC of a fixed label keyed by the
 * password, so there is no session store, every replica agrees, and rotating
 * the password signs everyone out. It is long-lived because the service worker
 * refetches pages in the background, where no login form can be shown.
 */
import { timingSafeEqual } from "node:crypto";
import { join, normalize, sep } from "node:path";

const password = process.env.TRANSMET_PASSWORD;
if (!password) throw new Error("TRANSMET_PASSWORD is required");

const port = Number(process.env.PORT ?? 3000);
const webDir = process.env.WEB_DIR ?? "/app/web";
const pagesDir = process.env.PAGES_DIR ?? "/pages";

const COOKIE = "transmet";
const MAX_AGE = 400 * 24 * 60 * 60;
const token = new Bun.CryptoHasher("sha256", password)
  .update("transmet-session-v1")
  .digest("hex");

/** Paths a browser fetches for the home-screen icon before anyone logs in. */
const PUBLIC = new Set([
  "/_health",
  "/login",
  "/app.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
]);

const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

function authed(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const value = cookie
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
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

function loginPage(failed: boolean) {
  return new Response(LOGIN_HTML.replace("{{error}}", failed ? "Wrong. Try again." : ""), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": REVALIDATE },
  });
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
          return Response.redirect("/login?e=1", 303);
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: "/",
            "set-cookie": `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          },
        });
      }
      return loginPage(url.searchParams.has("e"));
    }

    if (!PUBLIC.has(path) && !authed(req)) {
      const navigating = req.headers.get("sec-fetch-mode") === "navigate";
      return navigating
        ? Response.redirect("/login", 303)
        : new Response("unauthorised", { status: 401 });
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

console.log(`transmet listening on :${port}`);

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
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Trans<br><span>met</span></h1>
  <p>The city is waiting.</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Enter</button>
  <div class="err">{{error}}</div>
</form>
</body>
</html>`;
