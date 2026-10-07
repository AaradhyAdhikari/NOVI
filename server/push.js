import fs from 'node:fs';
import path from 'node:path';
import webPush from 'web-push';

// Phone notifications (Web Push) for when Novi isn't open on that phone.
// Messages are encrypted for the phone; Google / Apple only relay them.
// Only fixed, private-free texts are ever sent — never reminder text, email, file names or code.
const MESSAGES = {
  task_done: { body: 'Task finished', tag: 'task' },
  task_failed: { body: 'Task failed', tag: 'task' },
  approval: { body: 'Novi needs your OK', tag: 'approval' },
  reminder: { body: 'Reminder', tag: 'reminder' },
  briefing: { body: 'Your briefing is ready', tag: 'briefing' },
  pin_locked: { body: 'Wrong PIN 3 times', tag: 'security' },
};

export function createPush({ dir, lib = webPush, logger = console, subject = 'mailto:novi@localhost' }) {
  const keysFile = path.join(dir, 'vapid.json');
  const subsFile = path.join(dir, 'subscriptions.json');
  const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  const write = (file, data) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };

  let keys = read(keysFile, null);
  if (!keys) {
    keys = lib.generateVAPIDKeys();
    write(keysFile, keys);
  }
  let subs = read(subsFile, {}); // deviceId → [subscription]

  const drop = (deviceId, endpoint) => {
    subs[deviceId] = (subs[deviceId] || []).filter((s) => s.endpoint !== endpoint);
    if (!subs[deviceId].length) delete subs[deviceId];
    write(subsFile, subs);
  };

  return {
    publicKey: keys.publicKey,
    subscribe(deviceId, sub) {
      const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys?.p256dh && sub.keys?.auth;
      if (!ok) throw new Error('That is not a valid push subscription.');
      const clean = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
      subs[deviceId] = [...(subs[deviceId] || []).filter((s) => s.endpoint !== clean.endpoint), clean];
      write(subsFile, subs);
      return true;
    },
    has: (deviceId) => Boolean(subs[deviceId]?.length),
    removeDevice(deviceId) {
      if (!subs[deviceId]) return;
      delete subs[deviceId];
      write(subsFile, subs);
    },
    async send(deviceId, { kind } = {}) {
      const message = MESSAGES[kind];
      if (!message) return;
      const payload = JSON.stringify({ title: 'Novi', body: message.body, tag: message.tag, url: '/' });
      for (const sub of [...(subs[deviceId] || [])]) {
        try {
          await lib.sendNotification(sub, payload, { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) drop(deviceId, sub.endpoint);
          else logger.warn(`[push] could not notify a phone (${err.statusCode || err.message})`);
        }
      }
    },
  };
}
