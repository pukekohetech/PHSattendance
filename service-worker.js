// service-worker.js
// Basic offline "app shell" cache.
// NOTE: User-uploaded CSV data cannot be cached by the SW (browser security) —
// but the dashboard itself will work offline once installed.

const CACHE_NAME = "phs-attendance-pwa-v9";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./data/subject-map.json",
  "./data/email-templates.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
      self.clients.claim();
    })()
  );
});

// Cache-first for app shell, network-first for everything else
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only same-origin requests
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);

      // App shell: cache-first
      if (cached) return cached;

      // Otherwise: network-first, fallback to cache if available
      try {
        const res = await fetch(req);
        if (res && res.status === 200) {
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const fallback = await cache.match("./index.html");
        return fallback || new Response("Offline", { status: 503 });
      }
    })()
  );
});








