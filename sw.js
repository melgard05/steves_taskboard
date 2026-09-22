/* ====================================================================
   Service worker for the Mileage & Service Quote Calculator PWA.

   Strategy: network-first for the app's own files (so you always get
   the latest version when online), with a cached copy used as an
   offline fallback. Google Maps / Routes / Places requests are NOT
   intercepted - they always go straight to the network.
   ==================================================================== */

/* Cache version — BUMP THIS STRING ON EVERY DEPLOY (keep it in step with
   APP_VERSION in index.html). Changing it is what makes the browser install
   a new worker, which triggers the "new version available" banner. */
const CACHE = 'mqc-v1.9';
const SHELL = './';

self.addEventListener('install', event => {
  // Do NOT skipWaiting automatically — we want the new worker to WAIT so the
  // app can show an update banner. It activates when the user clicks Refresh
  // (which posts SKIP_WAITING below) or after all tabs close.
});

self.addEventListener('message', event => {
  // the page asks the waiting worker to take over immediately
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // only handle GET requests for THIS app's own files;
  // let Google APIs and any other cross-origin calls pass through untouched
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        // online: serve fresh and refresh the cached copy
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // offline: serve the cached file, falling back to the app shell
        caches.match(req).then(hit => hit || caches.match(SHELL))
      )
  );
});
