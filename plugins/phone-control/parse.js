// What to do on the phone, from the same words Screen Mode understands on the laptop
// (plugins/screen/mode.js): type (… and send), send it, tap X, go back / home, scroll, search for X.
import { parseScreenCommand } from '../screen/mode.js';

const PHONE = /\s*,?\s*\b(?:on|in) (?:my|the) phone\b|\bphone (?:pe|par|mein|me)\b\s*/gi;
// "type hi on my phone" / "phone pe …": the words are about the phone ("… to my phone" sends a link there).
export const onPhone = (text) => /\b(?:on|in) (?:my|the) phone\b|\bphone (?:pe|par|mein|me)\b/i.test(String(text || ''));

export function phoneCommand(text) {
  const t = String(text || '').replace(PHONE, ' ').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (/^(?:go (?:to )?(?:the )?home(?: screen)?|home screen)$/i.test(t)) return { do: 'home' };
  const s = parseScreenCommand(t);
  if (!s) return null;
  switch (s.do) {
    case 'type': return { do: 'type', text: s.text, ...(s.target ? { target: s.target } : {}), ...(s.enter ? { enter: true } : {}) };
    case 'search': return { do: 'type', text: s.query, enter: true, search: true };
    case 'click': return s.target ? { do: 'tap', target: s.target } : null;
    case 'scroll': return { do: 'scroll', dir: s.dir, ...(s.times > 1 ? { times: s.times } : {}) };
    case 'key': return s.key === 'enter' ? { do: 'enter' } : s.key === 'alt+left' ? { do: 'back' } : null;
    default: return null;
  }
}
