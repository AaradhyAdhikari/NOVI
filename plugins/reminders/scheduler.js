import { nextOccurrence } from './parse.js';

// setTimeout can't wait longer than ~24.8 days, so long waits are re-armed in chunks.
const CHUNK_MS = 6 * 3_600_000;

export class ReminderScheduler {
  constructor({ store, onFire, now = () => Date.now() }) {
    this.store = store;
    this.onFire = onFire;
    this.now = now;
    this.timers = new Map();
  }

  // Arms everything; reminders that came due while Novi was off fire now as "missed".
  start() {
    const t = this.now();
    for (const reminder of this.store.list()) {
      if (Date.parse(reminder.at) <= t) this._fire(reminder, true);
      else this.add(reminder);
    }
  }

  add(reminder) {
    this.cancel(reminder.id);
    const wait = Date.parse(reminder.at) - this.now();
    const handle = setTimeout(() => {
      const current = this.store.get(reminder.id);
      if (!current) return;
      if (Date.parse(current.at) - this.now() > 50) this.add(current); // not yet: next chunk
      else this._fire(current, false);
    }, Math.max(0, Math.min(wait, CHUNK_MS)));
    this.timers.set(reminder.id, handle);
  }

  cancel(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  stop() {
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }

  _fire(reminder, missed) {
    this.cancel(reminder.id);
    try {
      this.onFire(reminder, { missed });
    } finally {
      if (reminder.repeat) {
        let next = nextOccurrence(new Date(reminder.at), reminder.repeat);
        while (next.getTime() <= this.now()) next = nextOccurrence(next, reminder.repeat);
        this.add(this.store.update(reminder.id, { at: next.toISOString() }));
      } else {
        this.store.remove(reminder.id);
      }
    }
  }
}
