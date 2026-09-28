// Pages are cache-first: they never change, and a train tunnel has no network.
// The shell is network-first with a short timeout, so a deploy shows up on the
// next visit but a dead connection still opens the shop from cache.
const PAGES = "transmet-pages-v1";
const SHELL = "transmet-shell-v1";
const FONTS = "transmet-fonts-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function pages(req) {
  const cache = await caches.open(PAGES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Anything read online is kept too, so paging back through it later is free.
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, key) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(req), 3500);
    if (res.ok && !res.redirected) cache.put(key ?? req, res.clone());
    return res;
  } catch {
    return (await cache.match(key ?? req)) ?? Response.error();
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    return e.respondWith(cacheFirst(req, FONTS));
  }
  if (url.origin !== self.location.origin || url.pathname === "/login" || url.pathname.startsWith("/auth/")) return;

  if (url.pathname === "/pages/manifest.json") return e.respondWith(networkFirst(req));
  if (url.pathname.startsWith("/pages/")) return e.respondWith(pages(req));
  if (url.pathname.startsWith("/assets/")) return e.respondWith(cacheFirst(req, SHELL));
  if (req.mode === "navigate") return e.respondWith(networkFirst(req, "/"));
  e.respondWith(networkFirst(req));
});
