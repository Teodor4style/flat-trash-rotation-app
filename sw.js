const CACHE = "flat-trash-phase2-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.svg",
  "./icon-512.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("fetch", event => {
  // Supabase/API requests should always go to the network.
  if (event.request.url.includes("supabase.co") || event.request.url.includes("esm.sh")) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
