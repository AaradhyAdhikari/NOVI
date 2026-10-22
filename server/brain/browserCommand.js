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
// "… that I am late on WhatsApp": the end says where to send it, it isn't part of the message.
const WA_TAIL = /\s+(?:on|in|via|pe|par) (?:the |my )?whats ?app(?: (app|web))?$/i;
const msg = (to, text, via) => {
  if (!to) return null;
  let body = text.trim();
  const tail = WA_TAIL.exec(body);
  if (tail) { body = body.slice(0, tail.index).trim(); via = via || tail[1]; }
  return T('whatsapp_prepare', { to, text: body, ...VIA(via) });
};

const LAPTOP = /\b(?:on|in) (?:my |the )?(?:laptop|computer|pc)\b|\blaptop (?:pe|par|mein|me)\b/i;
const OPEN = /^\s*(?:(?:ok(?:ay)?|hey novi|novi|please)[, ]+)*open\b|\b(?:kholo|khol do|open karo)\b/i;

// "Copy the link of the current website and send it to Isha", "send this video to Rahul", "share this page
// with mom", "ye video Isha ko bhej do", "send this page to my phone", "copy this link" (2026-10-22, user:
// "copy the link of the current website or video and send it to X person"). The agent reads the page open
// in the laptop's front browser (laptop_current_link) and fills in the link.
const PAGE = '(?:link|url|page|website|site|video|tab|stream|song)';
const THE_PAGE = `(?:(?:the|this|that|current)\\s+)*(?:current\\s+)?${PAGE}(?:\\s+(?:of|from|on)\\s+(?:the\\s+|this\\s+)?(?:current\\s+|open\\s+)?${PAGE})?`;
const TO_PHONE = /^(?:my phone|phone|my mobile|mobile|me on (?:my )?phone)$/i;
export function linkCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '').replace(WA_TAIL, '');
  let m = new RegExp(`^copy\\s+${THE_PAGE}\\s+and\\s+(?:send|share)\\s+it\\s+(?:to|with)\\s+(.+)$`, 'i').exec(t)
    || new RegExp(`^(?:send|share|forward)\\s+${THE_PAGE}\\s+(?:to|with)\\s+(.+)$`, 'i').exec(t)
    || /^(?:ye|yeh|is|iss)\s+(?:link|video|page|website|gaana|song)\s+(?:ko\s+)?(.+?)\s+ko\s+(?:bhej(?:o| do| de)?|share kar(?:o| do))$/i.exec(t);
  if (m) {
    const to = m[1].replace(/\s+(?:please|now|right now)$/i, '').trim();
    if (!to) return null;
    if (TO_PHONE.test(to)) return { link: true, phone: true };
    return { ...T('whatsapp_prepare', { to }), link: true };
  }
  if (new RegExp(`^copy\\s+${THE_PAGE}$`, 'i').test(t)) return { link: true, copy: true };
  // "What's the link of this page", "which website is open" → the address in the reply (live: went to the AI).
  if (new RegExp(`^(?:what(?:'s|s| is)|tell me|give me|show me)\\s+(?:the\\s+)?(?:(?:current|this)\\s+)?(?:page\\s+|website\\s+|video\\s+)?(?:link|url|address)(?:\\s+(?:of|for)\\s+${THE_PAGE})?$`, 'i').test(t)
    || new RegExp(`^(?:tell me|give me|what(?:'s| is))\\s+${THE_PAGE}$`, 'i').test(t)
    || /^which\s+(?:page|website|site|tab|video)\s+is\s+(?:this|open)(?:\s+(?:on|in)\s+(?:my |the )?(?:laptop|browser|chrome|brave))?$/i.test(t)) return { link: true, phone: true };
  return null;
}

export function browserCommand(text, { lastTo = null } = {}) {
  const t = clean(text).replace(/[.!?]+$/, '');
  if (!t) return null;
  const link = linkCommand(t);
  if (link) return link;
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
  m = /^(?:tell|message|text) (.+?) on (?:the |my )?whats ?app(?: (app|web))?(?: that|:)? (?!(?:app|web)$)(.+)$/i.exec(t);
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
