import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { enableNotifications, installHint, isStandalone } from '../lib/push.js';

// Settings on a paired phone: notifications when Novi isn't open (task finished, approval needed,
// reminders, briefing). The texts are fixed and never contain private details.
export default function NotificationsSetup({ api }) {
  const [subscribed, setSubscribed] = useState(false);
  const [message, setMessage] = useState(null);
  useEffect(() => { api('/api/push/key').then((r) => r.json()).then((k) => setSubscribed(Boolean(k.subscribed))).catch(() => {}); }, [api]);
  const hint = installHint({ userAgent: navigator.userAgent, standalone: isStandalone() });

  async function turnOn() {
    setMessage(null);
    try {
      await enableNotifications(api);
      setSubscribed(true);
      // A test popup right away (live 2026-10-28: a card reached the laptop but not the phone).
      const test = await api('/api/push/test', { method: 'POST' }).then((r) => r.ok).catch(() => false);
      setMessage(test ? 'Notifications are on. A test popup is on its way — if it doesn’t show in a few seconds, check that Chrome may show notifications for Novi in your phone’s settings.' : 'Notifications are on for this phone.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  return (
    <div>
      <p className="muted">Get a notification when Novi needs your OK or finishes something while it isn't open. Tap it and Novi tells you what you missed.</p>
      {hint && <p className="muted">{hint}</p>}
      <button className="btn" onClick={turnOn}><Bell size={16} /> {subscribed ? 'Turn on again' : 'Enable notifications'}</button>
      {message && <p className="muted">{message}</p>}
    </div>
  );
}
