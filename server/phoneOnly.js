// Phone-only (user, 2026-11-07: "i want everything to be controlled from phone so completely off the laptops
// things"): the laptop says nothing, shows no Windows popups and doesn't open its mic for cards. Everything
// still shows in Novi's chat, and the phone reads and answers its cards as usual. Kept in data/phone-only.json.
import fs from 'node:fs';
import path from 'node:path';

export function createPhoneOnly({ file } = {}) {
  let on = false;
  try { on = JSON.parse(fs.readFileSync(file, 'utf8')).on === true; } catch { /* first run */ }
  return {
    isOn: () => on,
    set(value) {
      on = Boolean(value);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ on }));
      } catch { /* a setting that can't be saved must never break Novi */ }
    },
  };
}

const LEAD = /^(?:(?:hey )?novi[, ]+)?/i;
const ON = /^(?:(?:turn on |use )?phone[- ]only(?: mode)?(?: on)?|(?:turn off )(?:the )?laptop (?:voice|speech)|laptop (?:voice|speech) off)$/i;
const OFF = /^(?:(?:turn off )?phone[- ]only(?: mode)? off|turn off phone[- ]only(?: mode)?|(?:turn on )(?:the )?laptop (?:voice|speech)|laptop (?:voice|speech) on|laptop can (?:talk|speak))$/i;

// true = on, false = off, null = not about this.
export function phoneOnlyCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '').replace(LEAD, '');
  if (OFF.test(t)) return false;
  return ON.test(t) ? true : null;
}
