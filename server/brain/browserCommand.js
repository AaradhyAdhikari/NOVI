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

// "her" / "him" / "them" / "usko" = the last person messaged on WhatsApp (lastTo), else unknown.
const PRONOUN = /^(?:her|him|them|usko|use|isko|ise|unko)$/i;
// A name never keeps "on (my) WhatsApp" ("message Bhargav on my WhatsApp that …").
const ON_WA = /\s+(?:on|in|pe|par) (?:the |my )?whats ?app(?: (?:app|web))?$/i;
const person = (name, lastTo) => {
  const n = name.trim().replace(ON_WA, '');
  return PRONOUN.test(n) ? lastTo || null : n;
};
const msg = (to, text, via) => (to ? T('whatsapp_prepare', { to, text: text.trim(), ...VIA(via) }) : null);

const LAPTOP = /\b(?:on|in) (?:my |the )?(?:laptop|computer|pc)\b|\blaptop (?:pe|par|mein|me)\b/i;
const OPEN = /^\s*(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)*open\b|\b(?:kholo|khol do|open karo)\b/i;

export function browserCommand(text, { lastTo = null } = {}) {
  const t = clean(text).replace(/[.!?]+$/, '');
  if (!t) return null;
  // Any LeetCode phrasing about today's problem or the user's progress — never left to the AI, which
  // once played a YouTube video for "show me today's leetcode problem". Login / sign-in / "in
  // chrome" stay with the AI (browser tools).
  if (/\bleet ?code\b/i.test(t) && !/\b(?:login|log in|sign ?in|sign ?up|chrome|browser|tab)\b/i.test(t)) {
    if (/\b(?:stats?|streak|solved|progress|profile|score|rank(?:ing)?|kitne)\b/i.test(t)) return T('leetcode_stats');
    if (/\b(?:today'?s?|daily|aaj|potd|of the day|problem|question|challenge)\b/i.test(t)) {
      // "… on my laptop" (dropped by clean(), so read from the words as said) opens the problem there;
      // "open …" opens it on the device that asked.
      const open = LAPTOP.test(String(text)) ? 'laptop' : OPEN.test(String(text)) ? 'here' : null;
      return { ...T('leetcode_today'), ...(open ? { open } : {}) };
    }
  }
  let m = /^send (.+?) to (.+?) on (?:the |my )?whats ?app(?: (app|web))?$/i.exec(t);
  if (m) return fileOrText(m[1], m[2].trim(), m[3]);
  m = /^(.+?) ko (.+?) (?:bhej do|bhejo|bhej de)(?: (?:on )?whats ?app(?: (app|web))?(?: (?:pe|par))?| whats ?app (?:pe|par))$/i.exec(t);
  if (m) return fileOrText(m[2], m[1].trim(), m[3]);
  m = /^(?:tell|message|text) (.+?) on (?:the |my )?whats ?app(?: (app|web))?(?: that|:)? (.+)$/i.exec(t);
  if (m) return msg(person(m[1], lastTo), m[3], m[2]);
  // Plain "message / text someone …" (no app named) is WhatsApp; email words stay with the AI.
  if (!/\b(?:e-?mail|mail|gmail|sms)\b/i.test(t)) {
    m = /^send (?:a |an )?(?:message|text|msg) to (.+?) (?:saying|that|ki)(?: that)? (.+)$/i.exec(t)
      || /^(?:message|text|msg) (.+?) (?:saying|that)(?: that)? (.+)$/i.exec(t)
      || /^send (.+?) a (?:message|text|msg) (?:saying|that)(?: that)? (.+)$/i.exec(t)
      || /^(.+?) ko (?:message|msg|text) (?:karo|kar do|bhejo|bhej do)(?: ki)? (.+)$/i.exec(t);
    if (m) return msg(person(m[1], lastTo), m[2]);
  }
  m = /^whats ?app (.+?)[:,] (.+)$/i.exec(t);
  if (m) return T('whatsapp_prepare', { to: m[1].trim(), text: m[2].trim() });
  return null;
}

// "done" after a pause (QR code scanned, password typed, CAPTCHA solved).
export const isDoneWord = (text) => /^(?:done|ok(?:ay)? done|ho gaya|ho gya|i typed it|typed it|solved it|scanned it|i scanned it)$/i.test(clean(text));
