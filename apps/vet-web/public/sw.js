const CACHE = "timinow-vet-shell-v2";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/assets/anim/evander-sheet-1024.png",
  "/assets/brand/timinow-wordmark.svg",
  "/assets/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Never cache the API: the review queue and dashboard must always be live.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
  );
});
