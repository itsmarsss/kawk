/* Remember PWA service worker: push -> notification, click -> focus app.
   iOS requires every push to surface a visible notification (no silent pushes). */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Remember", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Remember";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "remember-card", // same tag: newer replaces older
      renotify: true,
      data: data.data || {},
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const win of wins) if ("focus" in win) return win.focus();
      return self.clients.openWindow("/");
    })
  );
});
