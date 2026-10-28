// Novi's service worker: phone notifications only. No offline caching — Novi lives on the laptop,
// so a cached page would only be out of date.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* plain text */ }
  if (data.type === 'card') { event.waitUntil(showCard(data)); return; }
  event.waitUntil(self.registration.showNotification(data.title || 'Novi', {
    body: data.body || 'Something new from Novi',
    tag: data.tag || 'novi',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

// A waiting card (user, 2026-10-28: it pops up wherever you are): the short task and up to two buttons,
// kept until answered. Not shown while Novi is on screen — the card is already there.
async function showCard(data) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!data.always && windows.some((w) => w.visibilityState === 'visible' && w.focused)) return;
  await self.registration.showNotification(data.title || 'Novi', {
    body: data.body || 'Novi needs your OK',
    tag: data.tag || `card-${data.id}`,
    renotify: true,
    requireInteraction: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    actions: (data.actions || []).slice(0, 2),
    data: { url: data.url || '/', cardId: data.id },
  });
}

// The phone's pairing token, shared by the page (src/lib/push.js shareToken) so a button can answer.
async function phoneToken() {
  try {
    const hit = await (await caches.open('novi-auth')).match('/novi-token');
    return hit ? await hit.text() : null;
  } catch { return null; }
}

async function answerCard(id, action) {
  const token = await phoneToken();
  const res = await fetch('/api/card-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ id, action }),
  });
  return res.json();
}

async function openNovi(url) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) if ('focus' in w) return w.focus();
  return self.clients.openWindow(url);
}

// A button answers the card right here; a card that needs the PIN (or more options), or a tap on the
// notification itself, brings Novi to the front on it (it then plays what you missed).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', cardId } = event.notification.data || {};
  event.waitUntil((async () => {
    if (cardId && event.action) {
      const result = await answerCard(cardId, event.action).catch(() => null);
      if (result?.done || result?.gone) return;
    }
    return openNovi(url);
  })());
});
