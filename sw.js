/* sw.js — Task Board push display worker.
   Deploy this file at the SAME path as task-board.html (e.g. repo root),
   so its scope covers the app. No edits needed. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (_) { d = { title: "Task Board", body: event.data ? event.data.text() : "" }; }

  const title = d.title || "Task Board";
  const options = {
    body: d.body || "",
    tag: d.taskId || "taskboard",
    renotify: true,
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
