// Quiet mode: Novi says nothing out loud (phone or laptop speakers); everything still shows on
// screen. "Novi, quiet" / "quiet for 30 minutes" / "talk again". Kept in data/quiet.json.
import fs from 'node:fs';
import path from 'node:path';

export function createQuiet({ file, now = Date.now } = {}) {
  let until = null; // ms, or Infinity for "until I say so"
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.on) until = saved.until ? Date.parse(saved.until) : Infinity;
  } catch { /* first run */ }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(until ? { on: true, until: Number.isFinite(until) ? new Date(until).toISOString() : null } : { on: false }));
    } catch { /* quiet mode must never break Novi */ }
  };
  const isOn = () => {
    if (until && now() >= until) { until = null; save(); }
    return Boolean(until);
  };
  return {
    on(minutes = null) { until = minutes ? now() + minutes * 60_000 : Infinity; save(); },
    off() { until = null; save(); },
    isOn,
    state: () => (isOn() ? { on: true, until: Number.isFinite(until) ? new Date(until).toISOString() : null } : { on: false, until: null }),
  };
}

const LEAD = /^(?:(?:hey )?novi[, ]+)?/i;
const AMOUNT = { a: 1, an: 1, one: 1, half: 0.5, 'half an': 0.5, 'half a': 0.5 };

// { quiet: true, minutes } | { quiet: false } | null. Bare "mute"/"unmute" stay the laptop volume.
export function quietCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '').replace(LEAD, '');
  let m = /^(?:be quiet|quiet|quiet mode(?: on)?|stay quiet|go quiet|shh+|chup(?: raho| ho jao| karo)?|silent mode|don'?t talk|mute yourself)(?: for (\d+|an?|one|half an?|half a) (minutes?|mins?|hours?))?$/i.exec(t);
  if (m) {
    if (!m[1]) return { quiet: true, minutes: null };
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : AMOUNT[m[1].toLowerCase()];
    return { quiet: true, minutes: Math.round(/^hour/i.test(m[2]) ? n * 60 : n) };
  }
  m = /^(?:talk again|speak again|you can (?:talk|speak)(?: again| now)?|quiet mode off|stop being quiet|unmute yourself|bol sakti ho|ab bolo|bolo ab|sound on)$/i.exec(t);
  return m ? { quiet: false } : null;
}
