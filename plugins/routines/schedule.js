// When a routine runs next. Its own day maths, not reminders': reminders read "7" as 7 or 19 and keep
// "every N hours" to 8 am–10 pm; a routine's time is a plain 24-hour HH:MM and hours run around the clock.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseAt(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? { h, m: mm } : null;
}

const daysOf = (every) => {
  if (every === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (every === 'weekdays') return [1, 2, 3, 4, 5];
  if (String(every).startsWith('weekly:')) return String(every).slice(7).split(',').map((d) => DAYS.indexOf(d.trim())).filter((d) => d >= 0);
  return null;
};
export const hoursOf = (every) => (String(every).startsWith('hourly:') ? Number(String(every).slice(7)) : null);

// The next time strictly after `from`, or null for an event routine (or a when that can't run).
export function nextRun(when, from) {
  if (!when || when.on) return null;
  const hours = hoursOf(when.every);
  if (hours != null) return Number.isInteger(hours) && hours >= 1 ? new Date(from.getTime() + hours * 3_600_000) : null;
  const days = daysOf(when.every);
  const t = parseAt(when.at);
  if (!days?.length || !t) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, t.h, t.m, 0, 0);
    if (d > from && days.includes(d.getDay())) return d;
  }
  return null;
}

export function describeWhen(when) {
  if (when?.on === 'coding_done') return 'when a coding task finishes';
  if (when?.on === 'team_task') return 'when the team finishes a task';
  const hours = hoursOf(when?.every);
  if (hours != null) return hours === 1 ? 'every hour' : `every ${hours} hours`;
  const at = when?.at ? ` at ${when.at}` : '';
  if (when?.every === 'daily') return `every day${at}`;
  if (when?.every === 'weekdays') return `every weekday${at}`;
  const days = daysOf(when?.every);
  return days?.length ? `every ${days.map((d) => SHORT[d]).join(', ')}${at}` : 'at an unknown time';
}
