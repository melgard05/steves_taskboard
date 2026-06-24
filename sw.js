/* sw.js — Task Board service worker.
   Deploy at the SAME path as index.html (repo root) so its scope covers the app.
   Handles: offline app-shell caching + background push notifications. */

const CACHE = "taskboard-shell-v2";   // bump this string when you want to force a cache refresh

/* ---------- offline app shell ---------- */
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "./index.html"]).catch(() => {})));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                 // never touch Firebase/worker writes
  const url = new URL(req.url);
  const isShell = req.mode === "navigate" ||
    (url.origin === self.location.origin && (url.pathname.endsWith("/") || url.pathname.endsWith("/index.html")));
  if (!isShell) return;                             // only the app page is cached; data stays live
  // Network-first so deploys show up immediately; fall back to cache when offline.
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: "no-store" });
      const c = await caches.open(CACHE);
      c.put("./index.html", fresh.clone()).catch(() => {});
      return fresh;
    } catch (_) {
      const cached = await caches.match("./index.html");
      return cached || new Response("<h1>Offline</h1><p>Reconnect to load Task Board.</p>", { headers: { "Content-Type": "text/html" } });
    }
  })());
});

/* ---------- background push ---------- */
self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (_) { d = { title: "Task Board", body: event.data ? event.data.text() : "" }; }
  const title = d.title || "Task Board";
  const options = {
    body: d.body || "",
    tag: d.taskId || "taskboard",
    renotify: true,
    requireInteraction: false,
    data: { url: d.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
