// hive web's service worker: keeps the app shell (page, script, styles, fonts, icons) so the installed app
// opens instantly, and refreshes it in the background. Never touches the WebSocket or /auth.
const CACHE = "hive-shell-v1";
const SHELL = ["./", "renderer.js", "styles.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.endsWith("/ws") || url.pathname.endsWith("/auth")) return;
  const key = req.mode === "navigate" ? "./" : req;
  // cached copy now, fresh copy for next time (a new build shows on the second open)
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(key);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") void c.put(key, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});
