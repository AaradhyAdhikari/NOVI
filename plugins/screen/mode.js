// Screen Mode (user's plan, 2026-10-29): "start screen control", then the whole screen by voice, one
// short command at a time — no AI for the plain ones ("click 3", "press enter", "minimize this").
// This file: what the words mean, which search results are which, and what is too risky to just do.
// The doing is in index.js (screen_command).

const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1, pehla: 1, doosra: 2, dusra: 2, teesra: 3 };
const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const num = (w) => {
  const s = String(w || '').toLowerCase();
  if (ORDINAL[s] !== undefined) return ORDINAL[s];
  const d = s.replace(/(?:st|nd|rd|th)$/, '');
  return /^\d+$/.test(d) ? Number(d) : NUMBER[s] ?? null;
};
const TIMES = { once: 1, twice: 2, thrice: 3 };
const times = (w) => (!w ? 1 : TIMES[w.toLowerCase()] ?? (num(String(w).replace(/\s*times?$/i, '')) || 1));

// Spoken key names → the screen plugin's key names.
const KEY_WORDS = {
  enter: 'enter', return: 'enter', escape: 'esc', esc: 'esc', tab: 'tab', space: 'space', spacebar: 'space', backspace: 'backspace',
  up: 'up', down: 'down', left: 'left', right: 'right', 'up arrow': 'up', 'down arrow': 'down', 'left arrow': 'left', 'right arrow': 'right',
  'page up': 'pageup', 'page down': 'pagedown', home: 'home', end: 'end', f5: 'f5',
};
export const KEY_LABEL = { enter: 'Enter', esc: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', up: 'Up', down: 'Down', left: 'Left', right: 'Right', pageup: 'Page Up', pagedown: 'Page Down', home: 'Home', end: 'End', f5: 'F5' };

const re = (src) => new RegExp(`^(?:${src})$`, 'i');
const ORD = `(${Object.keys(ORDINAL).join('|')}|\\d+(?:st|nd|rd|th))`;
const N = `(\\d+|${Object.keys(NUMBER).join('|')})`;
const T = `(once|twice|thrice|\\d+ times?|(?:${Object.keys(NUMBER).join('|')}) times?)`;
const THIS = '(?: (?:this|it|that|the window|this window|the app|this app))?';

const RULES = [
  [re('(?:start|turn on|switch on|begin|enable|open) (?:the )?screen (?:control|mode)(?: mode)?|screen (?:control|mode) (?:on|start)'), () => ({ do: 'start' })],
  [re("(?:stop|end|exit|quit|turn off|switch off|disable|close) (?:the )?screen (?:control|mode)(?: mode)?|screen (?:control|mode) off|stop(?: it| now)?|that'?s all"), () => ({ do: 'stop' })],
  [re('pause (?:the )?screen (?:control|mode)'), () => ({ do: 'pause' })],
  [re('(?:resume|continue|unpause) (?:the )?screen (?:control|mode)'), () => ({ do: 'resume' })],
  [re('what (?:did|have) you (?:just )?(?:do|done)|what was that|what did you just click'), () => ({ do: 'last' })],
  [re('undo(?: that| it| this| the last (?:one|thing|step))?'), () => ({ do: 'undo' })],
  [re("what(?:'s| is) on (?:the |my )?(?:laptop )?screen|what do you see|describe (?:the |my )?screen|what(?:'s| is) (?:open|in front)"), () => ({ do: 'look' })],
  [re('(?:list|read|show)(?: me)?(?: out)? (?:the |all (?:the )?)?(?:screen|buttons|links|items|options|things|everything|boxes|fields)(?: on (?:the |my )?screen)?|what can i (?:click|press|tap)(?: on)?'), () => ({ do: 'list' })],
  [re('show me (?:my |the )?(?:laptop )?screen|(?:take a )?screenshot'), () => ({ do: 'show' })],
  [re('(?:open |make )?(?:a )?new tab'), () => ({ do: 'key', key: 'ctrl+t', times: 1, say: 'New tab.' })],
  [re('(?:go )?back|go to the previous page'), () => ({ do: 'key', key: 'alt+left', times: 1, say: 'Went back.' })],
  [re('(?:go )?forward'), () => ({ do: 'key', key: 'alt+right', times: 1, say: 'Went forward.' })],
  [re('reload|refresh(?: (?:the|this) page)?|reload (?:the|this) page'), () => ({ do: 'key', key: 'f5', times: 1, say: 'Reloaded.' })],
  [re('close (?:this|the|that|current)(?: current)? tab'), () => ({ do: 'tab', action: 'close' })],
  [re(`(minimi[sz]e|maximi[sz]e)${THIS}`), (m) => ({ do: 'window', action: m[1].toLowerCase().startsWith('mini') ? 'minimize' : 'maximize' })],
  [re('close (?:this|the|that|it|current)(?: current)?(?: window| app)?'), () => ({ do: 'window', action: 'close' })],
  [re(`scroll (up|down)(?: ${T}| a (?:bit|little))?`), (m) => ({ do: 'scroll', dir: m[1].toLowerCase(), times: times(m[2]) })],
  [re(`(?:open|click|select|play|tap|pick)(?: on)? the ${ORD}(?: (?:result|search result|link|video|one))?`), (m) => ({ do: 'result', n: num(m[1]) })],
  [re(`(?:open|click) (?:result|video|link) (?:number )?${N}`), (m) => ({ do: 'result', n: num(m[1]) })],
  // type …
  [re('type (?:this |that )?(?:in|into) (?:the )?(.+?)\\s*[:,]\\s*(.+)'), (m) => ({ do: 'type', text: m[2], target: m[1] })],
  [re(`type (.+?) (?:in|into) (?:box|field|item|number) ${N}`), (m) => ({ do: 'type', text: m[1], n: num(m[2]) })],
  [re('type (.+?) (?:in|into) (?:that|this|the) (?:box|field)'), (m) => ({ do: 'type', text: m[1] })],
  [re('type(?: (?:this|that|out))?\\s*[:,]?\\s+(.+)'), (m) => ({ do: 'type', text: m[1] })],
  // click a number
  [re(`(?:click|tap|press|select|choose|open)(?: on)?(?: (?:option|number|item|no\\.?))? ${N}`), (m) => ({ do: 'click', n: num(m[1]) })],
  [re(`(?:option|number) ${N}`), (m) => ({ do: 'click', n: num(m[1]) })],
  // keys
  [re(`(?:press|hit|push) (?:the )?(.+?)(?: key)?(?: ${T})?`), (m) => ({ do: 'key', key: KEY_WORDS[m[1].toLowerCase()] || m[1].toLowerCase(), times: times(m[2]) })],
  [re(`(?:search|google|look up)(?: for| up)? (.+?)(?: and open the ${ORD}(?: (?:result|one|link))?)?`), (m) => ({ do: 'search', query: m[1], ...(m[2] ? { open: num(m[2]) } : {}) })],
  [re('(?:switch|go|jump|move) to (?:the )?(.+?)(?: window| app)?|bring (?:up )?(?:the )?(.+?)(?: window| app)? (?:to the front|forward|up|in front)|(?:show|focus) (?:the )?(.+?) (?:window|app)'), (m) => ({ do: 'focus', app: m[1] || m[2] || m[3] })],
  [re('(?:open|launch|start) (?:the )?(.+?)(?: app| application)?'), (m) => ({ do: 'open', app: m[1] })],
  [re('(?:click|tap|select|choose|hit)(?: on)? (.+)'), (m) => ({ do: 'click', target: m[1] })],
  [re('yes|yeah|yep|yup|ok|okay|sure|do it|open it|go ahead|haan|ha|theek hai'), () => ({ do: 'yes' })],
  [re("no|nope|nah|don'?t|cancel|nahi|leave it"), () => ({ do: 'no' })],
];

const LEAD = /^(?:(?:hey )?novi|okay|ok|please|now|and|then|can you|could you|will you)[,\s]+/i;
export function parseScreenCommand(text) {
  let t = String(text || '').trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  for (let i = 0; i < 4 && LEAD.test(t); i++) t = t.replace(LEAD, '');
  t = t.replace(/,?\s*(?:please|for me|right now)$/i, '').trim();
  if (!t) return null;
  for (const [pattern, make] of RULES) {
    const m = pattern.exec(t);
    if (m) return make(m);
  }
  return null;
}

// Search results / video tiles, top to bottom: the page's longer links (a result's title + address),
// not its menus ("Images", "Sign in") or the browser's own buttons. One per row.
const NAV = /^(?:all|images|videos|news|shopping|maps|books|flights|finance|more|tools|settings|sign in|log in|search|next|previous|feedback|privacy|terms|help|about|home|skip to .*|accessibility.*|google apps|google account.*|shorts|subscriptions|you|history)$/i;
// A web result's link names its address (Google: "Title … https://github.com"); when the page has
// those, only they count (live: the logo "Go to Google Home" and the sitelinks were counted too).
const ADDRESS = /https?:\/\/|\s›\s/;
export function pickResult(list, n) {
  const rows = [];
  const links = (list || []).filter((it) => it.type === 'Hyperlink' && !NAV.test(it.name) && !/^go to /i.test(it.name) && it.name.length >= 15 && it.name.split(/\s+/).length >= 3);
  const withAddress = links.filter((it) => ADDRESS.test(it.name));
  for (const it of [...(withAddress.length ? withAddress : links)].sort((a, b) => a.y - b.y)) {
    if (rows.some((r) => Math.abs(r.y - it.y) < 30)) continue;
    rows.push(it);
  }
  return (n === -1 ? rows.at(-1) : rows[n - 1]) || null;
}

// Where to click an item: its centre, except a tall link — a result's box holds the site name, its
// address and the title, and its middle can be empty space (live: Google didn't open), so its title line.
export function clickPoint(it) {
  if (it.type !== 'Hyperlink' || !(it.h >= 40) || !(it.w > 0)) return { x: it.x, y: it.y };
  const left = it.x - it.w / 2; const top = it.y - it.h / 2;
  return { x: Math.round(left + Math.min(it.w / 4, 120)), y: Math.round(top + it.h * 0.8) };
}

// The item a description means: every word in its name (login = "Log in" / "Sign in"), boxes first
// when the words say box/field, shortest name first.
const FILLER = new Set('the a an on in at of to button link click tap press icon please my this that one'.split(' '));
const BOXY = new Set(['box', 'field', 'bar', 'input']);
const ALIAS = { login: /\b(?:log ?in|sign ?in)\b/i, signin: /\b(?:log ?in|sign ?in)\b/i, logout: /\b(?:log ?out|sign ?out)\b/i, signup: /\b(?:sign ?up|register|create account)\b/i };
export function findTarget(list, target) {
  const words = String(target || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => !FILLER.has(w)) || [];
  const boxy = words.some((w) => BOXY.has(w));
  const want = words.filter((w) => !BOXY.has(w));
  if (!want.length) return null;
  const alias = ALIAS[want.join('')];
  const fits = (name) => (alias ? alias.test(name) : want.every((w) => name.toLowerCase().includes(w)));
  let hits = (list || []).filter((it) => fits(it.name));
  if (boxy) { const boxes = hits.filter((it) => it.type === 'Edit' || it.type === 'ComboBox'); if (boxes.length) hits = boxes; }
  return hits.sort((a, b) => a.name.length - b.name.length)[0] || null;
}

// What a click on something named like this would do: 'money' = never (do it yourself), 'destroy' =
// voice PIN, 'publish' = an explicit yes; null = just do it.
const MONEY = /\b(?:pay|payment|buy|purchase|place (?:your |the )?order|checkout|check out|transfer|send money|donate|add (?:a )?card|upi|subscribe now)\b/i;
const DESTROY = /\b(?:delete|remove|trash|recycle bin|empty|format|uninstall|install|erase|wipe|discard|reset|factory|shut ?down|restart|reboot)\b/i;
const PUBLISH = /\b(?:publish|deploy|push|post|send|submit|merge|release)\b/i;
export const clickRisk = (name) => (MONEY.test(name) ? 'money' : DESTROY.test(name) ? 'destroy' : PUBLISH.test(name) ? 'publish' : null);
const RANK = { money: 3, destroy: 2, publish: 1 };
export const riskRank = (r) => RANK[r] || 0;

// A screen where Novi keeps its hands off: password / payment / CAPTCHA / system security windows, or
// any window with a password, card or one-time-code box.
const SENSITIVE_TITLE = /password|passcode|sign[\s-]?in|log[\s-]?in|payment|checkout|shopping cart|\byour cart\b|\bbasket\b|bank|credit card|debit card|card number|cvv|\botp\b|one[\s-]?time code|captcha|windows security|user account control|credential|\bsettings\b/i;
const SECRET_BOX = /password|passcode|card number|cvv|cvc|\botp\b|one[\s-]?time|security code|\bpin\b|verification code/i;
// A secrets file open in an editor (live 2026-10-29: Notepad's active tab was the user's .env).
const SECRET_FILE = /(?:^|[\s\\/])(?:\.env(?:\.[\w-]+)?|id_rsa|id_ed25519|id_ecdsa|[\w.-]*\.(?:pem|key|pfx|p12|kdbx)|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?)(?=\s|$)/i;
export const sensitiveScreen = (title, items = []) => SENSITIVE_TITLE.test(String(title || '')) || SECRET_FILE.test(String(title || '')) || items.some((it) => (it.type === 'Edit' || it.type === 'ComboBox') && SECRET_BOX.test(String(it.name || '')));
export const secretWords = (text) => /\b(?:password|passcode|passwd|otp|one[\s-]?time code|pin|cvv|cvc|card number)\b/i.test(String(text || ''));
const CHAT = /whatsapp|telegram|discord|slack|teams|messenger|instagram|gmail|outlook|signal|mail/i;
export const chatApp = (title) => CHAT.test(String(title || ''));

// "GitHub - Google Search - Google Chrome" → "GitHub - Google Search".
export const shortTitle = (title) => String(title || '').replace(/\s+[-–—]\s+(?:Google Chrome|Brave|Microsoft​? Edge|Mozilla Firefox|Firefox|Opera|Vivaldi|Arc)$/i, '').trim() || 'the window';
export const capital = (s) => String(s || '').replace(/^\p{L}/u, (c) => c.toUpperCase());

// On / paused / off, ending itself after a quiet spell (so a forgotten Screen Mode doesn't keep taking
// stray words as commands).
export function createSession({ now = Date.now, idleMs = 15 * 60_000 } = {}) {
  let on = false; let paused = false; let touched = 0;
  return {
    isOn() { if (on && now() - touched > idleMs) on = false; return on; },
    get paused() { return paused; },
    start() { on = true; paused = false; touched = now(); },
    stop() { on = false; paused = false; },
    pause(p = true) { paused = p; touched = now(); },
    touch() { touched = now(); },
  };
}
