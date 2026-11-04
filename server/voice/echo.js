// What the mic heard minus Novi's own read-out. Live 2026-11-04: the laptop mic heard "Option 2", then the
// phone reading the card, and all of it went to Claude as the answer. Only a run of words that follows the
// read-out goes, so an answer that shares a word or two with the card stays.
const NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const MIN_RUN = 3;
const TAIL_MS = 20_000; // its echo may still be in a clip being transcribed
const START_MS = 1500;
const LATE_MS = 4000; // the voice is fetched first and may start late
const MS_PER_CHAR = 75;

const word = (w) => {
  const clean = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return NUMBERS[clean] || clean;
};

function typos(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && typos(a, b) <= 1);

// How many heard words from `h`, in order, follow the read-out from `s` (one read-out word may be missed).
function runFrom(heard, spoken, h, s) {
  let i = h;
  let j = s;
  while (i < heard.length && j < spoken.length) {
    if (same(heard[i], spoken[j])) { i++; j++; } else if (j + 1 < spoken.length && same(heard[i], spoken[j + 1])) { i++; j += 2; } else break;
  }
  return i - h;
}

export function withoutReadOut(text, lines, { reading = false } = {}) {
  const raw = String(text || '').split(/\s+/).filter(Boolean);
  const heard = raw.map(word);
  const keep = raw.map((w, i) => Boolean(heard[i]));
  for (const line of lines) {
    const spoken = String(line || '').split(/\s+/).map(word).filter(Boolean);
    for (let h = 0; h < heard.length;) {
      let best = 0;
      for (let s = 0; s < spoken.length; s++) best = Math.max(best, runFrom(heard, spoken, h, s));
      if (best >= MIN_RUN) {
        keep.fill(false, h, h + best);
        h += best;
      } else h++;
    }
  }
  // While she reads, a clip made only of her words is hers, however short ("Two, Green."): that is how an
  // echo would pick an option. "Option two" has a word of the user's own.
  const all = lines.flatMap((l) => String(l || '').split(/\s+/).map(word).filter(Boolean));
  if (reading && heard.every((w) => !w || all.some((s) => same(w, s)))) return '';
  return raw.filter((_, i) => keep[i]).join(' ');
}

// The cards being read out right now, on any device. add() returns how long the longest line takes.
export function createReadOuts({ now = Date.now } = {}) {
  let items = [];
  const count = (text) => String(text || '').split(/\s+/).filter(Boolean).length;
  return {
    add(lines) {
      const ms = START_MS + Math.max(0, ...lines.map((l) => String(l || '').length)) * MS_PER_CHAR;
      items = items.filter((r) => now() < r.keepUntil);
      items.push({ lines, readingUntil: now() + ms + LATE_MS, keepUntil: now() + ms + TAIL_MS });
      return ms;
    },
    done() {
      for (const r of items) r.readingUntil = Math.min(r.readingUntil, now());
    },
    reading: () => items.some((r) => now() < r.readingUntil),
    strip(text) {
      const lines = items.filter((r) => now() < r.keepUntil).flatMap((r) => r.lines);
      const out = withoutReadOut(text, lines, { reading: items.some((r) => now() < r.readingUntil) });
      return count(out) < count(text) ? { text: out, removed: true } : { text, removed: false };
    },
  };
}
