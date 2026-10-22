// Laptop controls by voice, without the AI (plugins/laptop-control): volume, brightness, media
// keys, battery, Wi-Fi/Bluetooth, power, windows and clipboard, in English and Hinglish.
// Returns { tool, args } (or { …, lastReply: true } for "copy your answer"), or null.
import { clean } from './phrases.js';

const T = (tool, args) => ({ tool, args });
const DEVICE = '(?: (?:the |my |this )?(?:laptop|computer|pc|screen|system))?';
const WIFI = '(wi-?fi|wi fi|bluetooth)';
const NOT_AN_APP = /^(?:novi|it|that|this|everything|all|laptop|computer|pc|screen|system|window|windows|tab|tabs|the laptop|my laptop)$/i;
const radioKind = (w) => (/blue/i.test(w) ? 'bluetooth' : 'wifi');
const re = (src) => new RegExp(`^(?:${src})$`, 'i');

const RULES = [
  // A screenshot of the laptop screen (live 2026-10-22: the AI said "Here's a screenshot" and took none).
  // A project's page ("screenshot of the homepage") stays with the preview.
  // "List what's on my screen" → the numbered list (live: the AI described the page instead of listing it)
  [re("(?:list|read out|read) (?:what(?:'s| is) on|everything on|the (?:things|items|buttons|links) on) (?:my |the )?(?:laptop )?screen|what can i (?:click|tap|press)(?: on (?:my |the )?screen)?|screen (?:pe|par) kya kya hai"), () => T('screen_items', {})],
  [re("(?:(?:show|send|give)(?: me)? (?:a |the |my )?(?:screenshot|screen ?shot|ss|picture|photo|pic) of (?:my |the )?(?:laptop |computer |pc )?screen|take (?:a )?(?:screenshot|screen ?shot|ss)(?: of (?:my |the )?(?:laptop |computer )?screen)?|(?:ss|screenshot) of (?:my |the )?(?:laptop |computer )?screen|show me (?:my |the )?(?:laptop |computer )?screen|screen ka (?:ss|screenshot) (?:bhejo|bhej do|dikhao)|what(?:'s| is) on (?:my |the )?(?:laptop )?screen)"), () => T('screen_show', {})],
  // volume
  [re('(?:set )?(?:the )?volume (?:to |at )?(\\d{1,3})(?: ?%| percent)?'), (m) => T('laptop_volume', { level: Number(m[1]) })],
  [re('(?:volume up|turn (?:the )?volume up|turn up (?:the )?volume|increase (?:the )?volume|louder|awaaz (?:badhao|badha do|tez karo|tez kar do)|volume badhao)'), () => T('laptop_volume', { change: 'up' })],
  [re('(?:volume down|turn (?:the )?volume down|turn down (?:the )?volume|decrease (?:the )?volume|lower (?:the )?volume|quieter|softer|awaaz (?:kam karo|kam kar do|dheere karo|dheere kar do)|volume kam karo)'), () => T('laptop_volume', { change: 'down' })],
  [re(`mute(?: (?:the )?(?:sound|audio|volume))?${DEVICE}`), () => T('laptop_volume', { mute: true })],
  [re(`unmute(?: (?:the )?(?:sound|audio|volume))?${DEVICE}`), () => T('laptop_volume', { mute: false })],
  // brightness
  [re('(?:set )?(?:the )?(?:screen )?brightness (?:to |at )?(\\d{1,3})(?: ?%| percent)?'), (m) => T('laptop_brightness', { level: Number(m[1]) })],
  [re('(?:brightness up|increase (?:the )?brightness|turn up (?:the )?brightness|brighter|brightness (?:badhao|badha do|tez karo|zyada karo))'), () => T('laptop_brightness', { change: 'up' })],
  [re('(?:brightness down|decrease (?:the )?brightness|turn down (?:the )?brightness|lower (?:the )?brightness|dim (?:the )?screen|dimmer|brightness (?:kam karo|kam kar do))'), () => T('laptop_brightness', { change: 'down' })],
  // media keys ("play X" with more words stays YouTube)
  [re('(?:pause|pause (?:the )?(?:music|song|video)|gaana roko)'), () => T('laptop_media', { key: 'pause' })],
  [re('(?:play|resume|play (?:the )?music|continue (?:the )?(?:music|song|video))'), () => T('laptop_media', { key: 'play' })],
  [re('(?:next (?:song|track|video)|skip(?: (?:this|the) (?:song|track))?|agla (?:gaana|song))'), () => T('laptop_media', { key: 'next' })],
  [re('(?:previous (?:song|track|video)|last song|pichla (?:gaana|song))'), () => T('laptop_media', { key: 'previous' })],
  // battery
  [re("(?:how much battery(?: is (?:left|there))?(?: do i have)?(?: left)?|battery(?: level| status| percentage)?|what(?:'s| is) (?:the |my )?battery(?: level| percentage)?|how(?:'s| is) (?:the |my )?battery|battery (?:kitni|kitna) (?:hai|bachi hai|bacha hai))"), () => T('laptop_battery', {})],
  // Wi-Fi / Bluetooth
  [re(`(?:turn|switch) (on|off) (?:the )?${WIFI}`), (m) => T('laptop_radio', { kind: radioKind(m[2]), on: m[1].toLowerCase() === 'on' })],
  [re(`(?:turn |switch )?(?:the )?${WIFI} (on|off)`), (m) => T('laptop_radio', { kind: radioKind(m[1]), on: m[2].toLowerCase() === 'on' })],
  [re(`(enable|disable) (?:the )?${WIFI}`), (m) => T('laptop_radio', { kind: radioKind(m[2]), on: m[1].toLowerCase() === 'enable' })],
  [re(`${WIFI} (?:band|bandh) (?:karo|kar do)`), (m) => T('laptop_radio', { kind: radioKind(m[1]), on: false })],
  [re(`${WIFI} (?:chalu|on|start) (?:karo|kar do)`), (m) => T('laptop_radio', { kind: radioKind(m[1]), on: true })],
  // power
  [re('(?:cancel|stop|abort) (?:the )?(?:shut ?down|restart|reboot)'), () => T('laptop_power', { action: 'cancel' })],
  [re(`lock${DEVICE}`), () => T('laptop_power', { action: 'lock' })],
  [re(`(?:sleep|go to sleep|sleep mode|put${DEVICE} to sleep)`), () => T('laptop_power', { action: 'sleep' })],
  [re(`(?:shut ?down${DEVICE}|(?:turn|switch|power) off (?:the |my )?(?:laptop|computer|pc))`), () => T('laptop_power', { action: 'shutdown' })],
  [re(`(?:restart|reboot)${DEVICE}`), () => T('laptop_power', { action: 'restart' })],
  [re('(?:sign|log) ?(?:out|off)(?: of (?:the |my )?(?:laptop|computer|windows))?'), () => T('laptop_power', { action: 'signout' })],
  // clipboard
  [re("(?:read (?:me )?what i(?:'ve| have)? copied|what(?:'s| is) (?:on|in) (?:my |the )?clipboard|read (?:my |the )?clipboard|what did i copy|(?:maine )?kya copy kiya(?: hai)?)"), () => T('laptop_clipboard', { do: 'read' })],
  [re('copy (?:your|that|the|this) (?:answer|reply|response)|copy what you (?:said|wrote)'), () => ({ tool: 'laptop_clipboard', args: { do: 'set' }, lastReply: true })],
  [re('copy (?:this|that|it|the selection|(?:the )?selected text)'), () => T('laptop_clipboard', { do: 'copy' })],
  [re('paste(?: it| this| that)?'), () => T('laptop_clipboard', { do: 'paste' })],
  [re('paste(?: it| this| that)? (?:in|into|to|on) (?:the )?(.+?)(?: window| app| chat)?'), (m) => app(m[1], (a) => T('laptop_clipboard', { do: 'paste', app: a }))],
  // windows
  [re('(?:switch|jump) to (?:the )?(.+?)(?: window| app)?|go to (?:the )?(.+?)(?: window| app)?'), (m) => app(m[1] || m[2], (a) => T('laptop_window', { app: a, do: 'focus' }))],
  [re('(minimi[sz]e|maximi[sz]e) (?:the )?(.+?)(?: window)?'), (m) => app(m[2], (a) => T('laptop_window', { app: a, do: m[1].toLowerCase().startsWith('mini') ? 'minimize' : 'maximize' }))],
  [re('close (?:this|the|that|my|current|it)(?: current)? tab|tab (?:band|bandh) (?:karo|kar do)'), () => T('laptop_tab', { do: 'close' })],
  [re('(?:re-?open|bring back|restore) (?:the |that |my )?(?:last |closed )*tab(?: again)?|(?:open|bring back) (?:the |that )?(?:last )?closed tab(?: again)?'), () => T('laptop_tab', { do: 'reopen' })],
  [re('close all (?:the |my )?(.+?)(?: windows| tabs)?'), (m) => app(m[1], (a) => T('laptop_window', { app: a, do: 'close', all: true }))],
  [re('close (?:the )?(.+?)(?: window| app)?'), (m) => app(m[1], (a) => T('laptop_window', { app: a, do: 'close' }))],
  [re('(.+?) (?:band|bandh) (?:karo|kar do)'), (m) => app(m[1], (a) => T('laptop_window', { app: a, do: 'close' }))],
  // "copy <words>" last, so "copy this" / "copy your answer" win. "copy the code" / "copy my email"
  // name something to find, not the words to copy: those go to the AI.
  [re('copy (.+)'), (m) => (/^(?:the|my|your|a|an|that|this|those|these)\b|\b(?:file|folder|pdf|docs?|to (?:the )?(?:desktop|downloads|documents))\b/i.test(m[1]) ? null : T('laptop_clipboard', { do: 'set', text: m[1] }))],
];

function app(name, make) {
  const a = String(name || '').trim();
  return a && !NOT_AN_APP.test(a) && a.split(/\s+/).length <= 4 ? make(a) : null;
}

// "Skip 10 minutes", "go back 30 seconds", "rewind five minutes", "10 minute aage karo", "jump to 5:30"
// → laptop_seek (live 2026-10-22: "skip 10 minutes from the video" went to the AI, which couldn't).
// An amount is needed: a bare "skip" stays "next song".
const NUMBER = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ek: 1, do: 2, teen: 3, char: 4, paanch: 5, das: 10, bees: 20, tees: 30 };
const AMOUNT = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER).join('|')})\\s*(hours?|hrs?|minutes?|mins?|minute|seconds?|secs?|second)\\b`, 'gi');
const AHEAD = /\b(?:skip|skip ahead|forward|fast[- ]?forward|ahead|aage|agey)\b/i;
const BACK = /\b(?:go back|skip back|jump back|move back|back by|rewind|backwards?|peeche|piche|pichhe|peechhe)\b/i;
const MEDIA_WORDS = /\b(?:the |this |my )?(?:video|song|music|track|movie|youtube video|youtube)\b/gi;
function seekCommand(t) {
  const s = t.toLowerCase();
  const clockTo = /^(?:jump|skip|go|seek|move)\s+to\s+(?:(?:the\s+)?(?:minute\s+(\d+)|(\d{1,2}):(\d{2})(?::(\d{2}))?|(\d+)\s*(?:minutes?|mins?)(?:\s+(\d+)\s*(?:seconds?|secs?))?))\b/i.exec(s);
  if (clockTo) {
    const [, minute, a, b, c, mins, secs] = clockTo;
    const to = minute ? Number(minute) * 60 : a ? (c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b)) : Number(mins) * 60 + Number(secs || 0);
    return T('laptop_seek', { to });
  }
  // "remind me to go back home in 10 minutes", "timer for 10 minutes": time words, not a skip.
  if (/\b(?:remind|reminder|timer|alarm|email|mail|message|after|later|in\s+(?:\d+|a|an|one|two|five|ten)\s)/i.test(s)) return null;
  const back = BACK.test(s);
  if (!back && !AHEAD.test(s)) return null;
  let total = 0;
  for (const [, n, unit] of s.replace(MEDIA_WORDS, ' ').matchAll(AMOUNT)) {
    const v = NUMBER[n] ?? Number(n);
    total += /^h/.test(unit) ? v * 3600 : /^m/.test(unit) ? v * 60 : v;
  }
  if (!total) return null;
  return T('laptop_seek', { by: back ? -total : total });
}

export function controlCommand(text) {
  const t = clean(text);
  if (!t) return null;
  const seek = seekCommand(t);
  if (seek) return seek;
  for (const [pattern, make] of RULES) {
    const m = pattern.exec(t);
    if (m) return make(m);
  }
  return null;
}

// During a shut down / restart countdown, these words cancel it first.
export const isCancelWord = (text) => /^(?:cancel|stop|abort|ruko|ruk jao|rok do|rok|mat karo)(?: (?:it|that|the (?:shut ?down|restart|reboot)))?$/i.test(clean(text));

// "What commands did you run today?" → the command history (plugins/commands), without the AI.
export function historyCommand(text) {
  const t = clean(text);
  return /^(?:what (?:commands|command) (?:did|have) (?:you|u) (?:run|ran)(?: today)?|(?:show|read)(?: me)? (?:the |my )?command history|(?:aaj )?kaun se commands? chala(?:ye|ya|e)(?: hai)?)$/i.test(t)
    ? { tool: 'commands_history', args: { today: true } } : null;
}

// "How much free space is on my C drive?" / "storage left" / "C drive me kitni jagah bachi hai" →
// laptop_disk (a fixed command, Windows units), no AI. "Free up space" (cleaning) stays with the AI.
// "Which AI keys are missing" / "check my API keys" → ai_keys_status (plugins/ai-keys), no AI.
export function keysCommand(text) {
  const t = clean(text).replace(/[.!?]+$/, '');
  return /\b(?:ai|api)\s+(?:keys?|providers?)\b/i.test(t) && /\b(?:which|what|check|missing|list|show|kaunsi|kaun|do i have)\b/i.test(t)
    ? { tool: 'ai_keys_status', args: {} } : null;
}

export function diskCommand(text) {
  const t = clean(text).replace(/[.!?]+$/, '');
  if (/\b(?:free up|clean|clear|delete|remove)\b/i.test(t)) return null;
  const asks = /\b(?:free space|space (?:left|free|available)|storage (?:left|free|available)|how much (?:free )?(?:space|storage)|space on|kitni jagah|jagah bachi|storage kitna)\b/i.test(t);
  if (!asks || !/\b(?:drive|disk|storage|laptop|[a-z]:|jagah)/i.test(t)) return null;
  const m = /\b([a-z]) ?drive\b/i.exec(t) || /\b([a-z]):/i.exec(t);
  return { tool: 'laptop_disk', args: { drive: (m ? m[1] : 'C').toUpperCase() } };
}
