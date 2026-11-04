import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Small cards that only say something happened ("Claude finished in NOVI"): nothing to decide, one OK.
// `key` keeps it to one card per thing: a newer one takes the place of the last. OK on any device clears
// it everywhere, and the oldest go when too many pile up.
// A session finishes many small turns: its card updates each time, but buzzes and speaks once a minute.
const QUIET_MS = 60_000;

export function createNotices({ limit = 10, now = Date.now } = {}) {
  const events = new EventEmitter();
  let items = [];
  const lastSound = new Map(); // key → when it last made a sound
  const drop = (id) => {
    const had = items.some((n) => n.id === id);
    items = items.filter((n) => n.id !== id);
    if (had) events.emit('gone', { id });
    return had;
  };
  return {
    on: (name, fn) => events.on(name, fn),
    add({ key, title, body = '' }) {
      for (const n of items.filter((x) => key && x.key === key)) drop(n.id);
      const repeat = Boolean(key) && now() - (lastSound.get(key) ?? -Infinity) < QUIET_MS;
      if (!repeat) lastSound.set(key, now());
      const notice = { id: crypto.randomUUID(), key, title: String(title).slice(0, 120), body: String(body).slice(0, 200), at: now(), repeat };
      items.push(notice);
      while (items.length > limit) drop(items[0].id);
      events.emit('added', notice);
      return notice;
    },
    ok: drop,
    list: () => [...items],
  };
}
