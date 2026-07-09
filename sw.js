// Minimal offline service worker: precache the app shell so the tool
// opens instantly and works without a network. Live data (weather, NEEP,
// prices) is always fetched fresh when online.
const CACHE = "dualfuel-v5";
const SHELL = [
  ".",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "assets/icon.svg",
  "assets/gear.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/apple-touch-icon.png",
  "data/prices.js",
  "data/heatpumps.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache cross-origin API calls; always go to network.
  if (url.origin !== location.origin) return;
  e.respondWith(
    // Network-first. Use cache:'reload' so the browser does NOT send
    // If-Modified-Since / conditional headers -- otherwise the dev server
    // returns 304 and the stale cached CSS/JS keeps getting reused. Always
    // fetch a fresh 200, then update the cache.
    fetch(req, { cache: "reload" }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req))
  );
});
