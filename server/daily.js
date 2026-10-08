import fs from 'node:fs';
import path from 'node:path';

// A job that runs once a day at a local time (e.g. the nightly Drive backup, the Sheets rows).
// If the laptop was asleep or Novi was off at that time, the missed day runs once on the next
// check (at most one catch-up, for yesterday). A failed run is retried on the next check.
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function everyDayAt({ time, run, stateFile, now = () => new Date(), tickMs = 60_000, logger = console }) {
  const [hh, mm] = String(time).split(':').map(Number);
  const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const save = (lastDay) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ lastDay }));
  };
  let busy = false;
  let timer = null;

  async function attempt(day) {
    try {
      await run(day);
      save(day);
      return true;
    } catch (err) {
      logger.warn?.(`[daily] ${path.basename(stateFile, '.json')} for ${day} failed: ${err.message}`);
      return false;
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const n = now();
      const today = dayOf(n);
      const yesterday = dayOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1));
      const { lastDay } = read();
      if (lastDay && lastDay < yesterday && !(await attempt(yesterday))) return;
      const due = n.getHours() > hh || (n.getHours() === hh && n.getMinutes() >= mm);
      if (due && (read().lastDay || '') < today) await attempt(today);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() {
      tick();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
