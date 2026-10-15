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
  [re('close all (?:the |my )?(.+?)(?: windows| tabs)?'), (m) => app(m[1], (a) => T('laptop_window', { app: a, do: 'close', all: true }))],
  [re('close (?:the )?(.+?)(?: window| app)?'), (m) => app(m[1], (a) => T('laptop_window', { app: a, do: 'close' }))],
  [re('(.+?) (?:band|bandh) (?:karo|kar do)'), (m) => app(m[1], (a) => T('laptop_window', { app: a, do: 'close' }))],
  // "copy <words>" last, so "copy this" / "copy your answer" win
  [re('copy (.+)'), (m) => (/\b(?:file|folder|pdf|docs?|to (?:the )?(?:desktop|downloads|documents))\b/i.test(m[1]) ? null : T('laptop_clipboard', { do: 'set', text: m[1] }))],
];

function app(name, make) {
  const a = String(name || '').trim();
  return a && !NOT_AN_APP.test(a) && a.split(/\s+/).length <= 4 ? make(a) : null;
}

export function controlCommand(text) {
  const t = clean(text);
  if (!t) return null;
  for (const [pattern, make] of RULES) {
    const m = pattern.exec(t);
    if (m) return make(m);
  }
  return null;
}

// During a shut down / restart countdown, these words cancel it first.
export const isCancelWord = (text) => /^(?:cancel|stop|abort|ruko|ruk jao|rok do|rok|mat karo)(?: (?:it|that|the (?:shut ?down|restart|reboot)))?$/i.test(clean(text));
