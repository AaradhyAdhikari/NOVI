// Novi's service worker: phone notifications only. No offline caching — Novi lives on the laptop,
// so a cached page would only be out of date.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* plain text */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Novi', {
    body: data.body || 'Something new from Novi',
    tag: data.tag || 'novi',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

// Tap → bring Novi to the front (it then plays what you missed).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) if ('focus' in w) return w.focus();
    return self.clients.openWindow(event.notification.data?.url || '/');
  })());
});
