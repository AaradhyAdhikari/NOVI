// LeetCode and WhatsApp by voice, without the AI (plugins/leetcode, plugins/browser).
// WhatsApp: "send my X folder to Y on WhatsApp", "Y ko X bhej do whatsapp pe", "tell Y on WhatsApp
// that …", "WhatsApp Y: …". A file/folder comes back as { find, kind } for the files plugin to
// locate first; sending always asks (whatsapp_send).
import { clean } from './phrases.js';

const KIND = /\s+(folder|file|pdf|docx?|document|zip|photo|picture|image|ppt|pptx|presentation|sheet|spreadsheet|notes?)$/i;
const FILEISH = /\b(?:folder|file|pdf|docx?|document|zip|photo|picture|image|ppt|pptx|presentation|sheet|spreadsheet|notes?|report|resume|cv|assignment|project)\b/i;
const VIA = (w) => (w ? { via: /app/i.test(w) ? 'app' : 'web' } : {});
const T = (tool, args = {}) => ({ tool, args });

function fileOrText(what, to, via) {
  const w = what.trim().replace(/^(?:my|the|mera|meri|mere)\s+/i, '');
  if (!FILEISH.test(w)) return T('whatsapp_prepare', { to, text: w, ...VIA(via) });
  const m = KIND.exec(w);
  const kind = m && !/^notes?$/i.test(m[1]) ? m[1].toLowerCase() : 'file';
  const find = m && !/^notes?$/i.test(m[1]) ? w.slice(0, m.index).trim() : w;
  return { tool: 'whatsapp_prepare', find, kind, args: { to, ...VIA(via) } };
}

export function browserCommand(text) {
  const t = clean(text);
  if (!t) return null;
  if (/^(?:(?:what(?:'s| is) )?(?:today'?s|the daily|daily) (?:leetcode|leet code)(?: problem| question| challenge)?|leetcode (?:today'?s |daily )?(?:problem|question|challenge)(?: of the day| today)?|leetcode today|aaj ka leetcode(?: (?:problem|question))?(?: kya hai)?)$/i.test(t)) return T('leetcode_today');
  if (/^(?:(?:show |tell me )?my leetcode (?:stats|progress|score|profile)|leetcode (?:stats|progress)|how many leetcode (?:problems|questions) (?:have i|did i) solved?)$/i.test(t)) return T('leetcode_stats');
  let m = /^send (.+?) to (.+?) on (?:the )?whats ?app(?: (app|web))?$/i.exec(t);
  if (m) return fileOrText(m[1], m[2].trim(), m[3]);
  m = /^(.+?) ko (.+?) (?:bhej do|bhejo|bhej de)(?: (?:on )?whats ?app(?: (app|web))?(?: (?:pe|par))?| whats ?app (?:pe|par))$/i.exec(t);
  if (m) return fileOrText(m[2], m[1].trim(), m[3]);
  m = /^(?:tell|message|text) (.+?) on (?:the )?whats ?app(?: (app|web))?(?: that|:)? (.+)$/i.exec(t);
  if (m) return T('whatsapp_prepare', { to: m[1].trim(), text: m[3].trim(), ...VIA(m[2]) });
  m = /^whats ?app (.+?)[:,] (.+)$/i.exec(t);
  if (m) return T('whatsapp_prepare', { to: m[1].trim(), text: m[2].trim() });
  return null;
}

// "done" after a pause (QR code scanned, password typed, CAPTCHA solved).
export const isDoneWord = (text) => /^(?:done|ok(?:ay)? done|ho gaya|ho gya|i typed it|typed it|solved it|scanned it|i scanned it)$/i.test(clean(text));
