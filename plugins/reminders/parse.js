// Turns spoken times ("in 10 minutes", "at 6", "tomorrow at 9", "Monday at 5") into dates.
// Done in code, not by the AI, so reminders never land at a made-up time.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_WORDS = `today|tonight|tomorrow|${WEEKDAYS.join('|')}`;
const UNIT_MS = { second: 1000, minute: 60_000, hour: 3_600_000 };

function unitOf(word) {
  if (/^(s|secs?|seconds?)$/.test(word)) return 'second';
  if (/^(m|mins?|minutes?)$/.test(word)) return 'minute';
  if (/^(h|hrs?|hours?)$/.test(word)) return 'hour';
  return null;
}

const dateAt = (base, dayOffset, hour, minute) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0);

// { at: Date, rolled } or null. `rolled` = the time had already passed today, so the next one was used.
export function parseWhen(input, now = new Date()) {
  let t = String(input || '').toLowerCase().trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  if (!t) return null;

  const rel = /^in (an?|half an?|\d+(?:\.\d+)?) ?([a-z]+)$/.exec(t);
  if (rel) {
    const unit = unitOf(rel[2]);
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : rel[1].startsWith('half') ? 0.5 : Number(rel[1]);
    if (!unit || !(n > 0)) return null;
    return { at: new Date(now.getTime() + n * UNIT_MS[unit]), rolled: false };
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(t);
  if (iso) {
    const d = new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]);
    return d > now ? { at: d, rolled: false } : null;
  }

  let day = null;
  let m = new RegExp(`^(?:on )?(${DAY_WORDS})\\b(?: at)?\\s*(.*)$`).exec(t);
  if (m) [, day, t] = m;
  else if ((m = new RegExp(`^(.*?)\\s+(?:on )?(${DAY_WORDS})$`).exec(t))) [, t, day] = m;
  t = t.replace(/^at /, '').trim();

  let hours;
  let minute = 0;
  if (t === 'noon') hours = [12];
  else if (t === 'midnight') hours = [0];
  else {
    const clock = /^(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m|p\.m|a\.m\.|p\.m\.)?$/.exec(t);
    if (!clock) return null;
    const hour = Number(clock[1]);
    minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3] ? clock[3][0] : null;
    if (minute > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hours = [(hour % 12) + (meridiem === 'p' ? 12 : 0)];
    } else if (hour === 0 || hour > 12 || clock[2] && hour >= 13) {
      if (hour > 23) return null;
      hours = [hour];
    } else if (day === 'tonight') {
      hours = [(hour % 12) + 12];
    } else if (day) {
      // With a day named and no am/pm: 7–11 → morning, 12 → noon, 1–6 → afternoon/evening.
      hours = [hour >= 7 && hour <= 11 ? hour : hour === 12 ? 12 : hour + 12];
    } else {
      hours = [hour % 12, (hour % 12) + 12]; // am or pm, whichever comes next
    }
  }

  if (!day || day === 'today' || day === 'tonight') {
    const next = hours.map((h) => dateAt(now, 0, h, minute)).filter((d) => d > now).sort((a, b) => a - b)[0];
    if (next) return { at: next, rolled: false };
    if (day) return null; // "today at 2 am" when it's already past
    return { at: dateAt(now, 1, Math.min(...hours), minute), rolled: true };
  }
  if (day === 'tomorrow') return { at: dateAt(now, 1, hours[0], minute), rolled: false };
  const diff = (WEEKDAYS.indexOf(day) - now.getDay() + 7) % 7;
  let at = dateAt(now, diff, hours[0], minute);
  if (at <= now) at = dateAt(now, diff + 7, hours[0], minute);
  return { at, rolled: false };
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// "6:00 pm today", "9:00 am tomorrow", "Monday 5:00 pm", "20 Oct 8:00 am"
export function describeTime(at, now = new Date()) {
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ').toLowerCase();
  if (sameDay(at, now)) return `${time} today`;
  if (sameDay(at, dateAt(now, 1, 0, 0))) return `${time} tomorrow`;
  const days = Math.round((dateAt(at, 0, 0, 0) - dateAt(now, 0, 0, 0)) / 86_400_000);
  if (days > 0 && days < 7) return `${at.toLocaleDateString('en-US', { weekday: 'long' })} ${time}`;
  return `${at.getDate()} ${at.toLocaleDateString('en-US', { month: 'short' })} ${time}`;
}

export function nextOccurrence(at, repeat) {
  let next = dateAt(at, 1, at.getHours(), at.getMinutes());
  if (repeat === 'weekdays') while (next.getDay() === 0 || next.getDay() === 6) next = dateAt(next, 1, at.getHours(), at.getMinutes());
  return next;
}
