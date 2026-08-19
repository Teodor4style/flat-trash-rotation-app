const CACHE = "flat-trash-notifications-v2";

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
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(names =>
        Promise.all(
          names
            .filter(name => name !== CACHE)
            .map(name => caches.delete(name))
        )
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener("fetch", event => {
  if (
    event.request.url.includes("supabase.co") ||
    event.request.url.includes("esm.sh")
  ) {
    return;
  }

  event.respondWith(
    caches
      .match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

self.addEventListener("push", event => {
  let notification = {
    title: "Flat Trash",
    body: "You have a new notification.",
    url: "./",
    icon: "./icon-192.svg",
    badge: "./icon-192.svg"
  };

  if (event.data) {
    const text = event.data.text();

    try {
      notification = {
        ...notification,
        ...JSON.parse(text)
      };
    } catch {
      notification.body = text;
    }
  }

  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      icon: notification.icon,
      badge: notification.badge,
      data: {
        url: notification.url || "./"
      }
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "./",
    self.location.origin
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({
        type: "window",
        includeUncontrolled: true
      })
      .then(async windows => {
        for (const windowClient of windows) {
          if ("focus" in windowClient) {
            await windowClient.focus();

            if ("navigate" in windowClient) {
              await windowClient.navigate(targetUrl);
            }

            return;
          }
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});