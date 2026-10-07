// Phone notifications: register Novi's service worker and subscribe this phone (Web Push).

export function keyToBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// iPhones only allow notifications for web apps opened from the Home Screen (iOS 16.4+).
export function installHint({ userAgent = '', standalone = false } = {}) {
  const ios = /iPhone|iPad|iPod/.test(userAgent);
  return ios && !standalone ? 'On iPhone: tap Share → Add to Home Screen, open Novi from that icon, then turn notifications on.' : null;
}

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js').catch(() => null);
}

export async function enableNotifications(api) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser cannot show notifications from Novi.');
  const hint = installHint({ userAgent: navigator.userAgent, standalone: isStandalone() });
  if (hint) throw new Error(hint);
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for Novi in this browser.');
  const reg = await registerServiceWorker();
  if (!reg) throw new Error('Could not start notifications (open Novi through its https address).');
  const { publicKey } = await (await api('/api/push/key')).json();
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  const res = await api('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not turn notifications on.');
}
