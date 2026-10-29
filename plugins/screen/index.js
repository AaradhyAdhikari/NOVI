import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';
import { pageShot } from './pageShot.js';
import { parseScreenCommand, pickResult, findTarget, clickRisk, riskRank, sensitiveScreen, secretWords, chatApp, shortTitle, capital, createSession, clickPoint, KEY_LABEL } from './mode.js';

// Screen control: look at the screen (Gemini vision — the user agreed screenshots may go to Gemini),
// click a described element, type, press a key. Every action needs approval (category "screen",
// grantable) and none happens on password / payment / CAPTCHA / system-security screens.
// Spec: docs/superpowers/specs/2026-10-08-novi-screen-control-design.md

const SENSITIVE = /password|passcode|sign[\s-]?in|log[\s-]?in|payment|checkout|bank|credit card|debit card|card number|cvv|\botp\b|one[\s-]?time code|captcha|windows security|user account control|credential|\bsettings\b/i;

// Allowed keys → Windows SendKeys codes. Nothing system-level (Win+R, Alt+F4, Ctrl+Alt+Del, Delete).
const KEY_CODES = {
  enter: '{ENTER}', tab: '{TAB}', 'shift+tab': '+{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ', backspace: '{BACKSPACE}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', pageup: '{PGUP}', pagedown: '{PGDN}', home: '{HOME}', end: '{END}',
  'ctrl+a': '^a', 'ctrl+c': '^c', 'ctrl+v': '^v', 'ctrl+x': '^x', 'ctrl+z': '^z', 'ctrl+s': '^s', 'ctrl+f': '^f', 'ctrl+n': '^n', 'ctrl+t': '^t', 'alt+tab': '%{TAB}',
  'ctrl+w': '^w', 'ctrl+shift+t': '^+t', 'alt+left': '%{LEFT}', 'alt+right': '%{RIGHT}', f5: '{F5}',
};
export const KEYS = Object.keys(KEY_CODES);
const normKey = (k) => String(k || '').toLowerCase().replace(/\s+/g, '').replace('control', 'ctrl').replace('return', 'enter');

// Gemini points at things as [y, x] on a 0–1000 grid.
export const toPixels = ([y, x], width, height) => ({ x: Math.round((x / 1000) * width), y: Math.round((y / 1000) * height) });

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'win.ps1');
function ps(args, env = {}) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
    windowsHide: true, timeout: 20_000, env: { ...process.env, ...env },
  }, (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(out).trim()))));
}

export const windowsDriver = {
  async screenshot() {
    const file = path.join(os.tmpdir(), `novi-screen-${crypto.randomUUID()}.png`);
    try {
      const [width, height] = (await ps(['shot', file])).split(/\s+/).map(Number);
      return { png: fs.readFileSync(file), width, height };
    } finally {
      fs.rmSync(file, { force: true });
    }
  },
  window: () => ps(['window']),
  items: async () => { const out = JSON.parse(await ps(['items'])); return { title: out.title || '', hwnd: Number(out.hwnd) || null, items: [].concat(out.items || []) }; },
  // The foreground window's handle and title; focus by handle (checked: True only if it is in front).
  front: async () => { const [h, ...t] = (await ps(['front'])).split('\t'); return { hwnd: Number(h) || null, title: t.join('\t') }; },
  focusHandle: async (hwnd) => (await ps(['focushwnd', String(hwnd)])) === 'True',
  click: (x, y) => ps(['click', String(x), String(y)]),
  type: (text) => ps(['type'], { NOVI_SCREEN_TEXT: String(text) }),
  key: (name) => ps(['key', KEY_CODES[name]]),
  focus: async (app) => (await ps(['focus'], { NOVI_SCREEN_APP: String(app) })) === 'True',
  // Mouse wheel over the front app (not Novi): notches, negative = down.
  scroll: (notches) => ps(['scroll', String(Math.trunc(notches))]),
  // A picture of a web page from a hidden Edge (its own empty profile, so not signed in anywhere).
  pageShot: (url) => pageShot(url),
};

const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ...details, sensitive: true } });
const refuse = (what) => reply(`I won't ${what} here: it looks like a password, payment, CAPTCHA or system security screen. Please do that part yourself.`);

// The front window's links, buttons, tiles… from Windows' accessibility tree (UI Automation): names and
// positions without any AI (live 2026-10-22: Gemini vision was overloaded and screen control was blind).
const KIND = { Hyperlink: 'link', Button: 'button', ListItem: 'item', Edit: 'box', TabItem: 'tab', MenuItem: 'menu', CheckBox: 'checkbox', RadioButton: 'option', ComboBox: 'list', Image: 'picture', TreeItem: 'item', DataItem: 'item' };
const PREFER = ['Hyperlink', 'Button', 'MenuItem', 'TabItem', 'CheckBox', 'RadioButton', 'Edit', 'ComboBox', 'Image', 'ListItem', 'TreeItem', 'DataItem'];
const SECRET_FIELD = /password|passcode|card number|cvv|\botp\b|one[\s-]?time|pin\b/i;
// The window's and browser's own buttons: kept (still clickable by name) but listed after the page's items.
const BROWSER_UI = /^(?:minimi[sz]e|maximi[sz]e|restore|close|back|forward|reload|home|new tab|search tabs|tab search|bookmark this tab|view site information|address and search bar|zoom: \d+%|install .+|brave (?:shields|rewards|wallet)|brave|vpn|leo ai|(?:show|hide) sidebar|extensions|side panel|downloads?|customi[sz]e and control .+|(?:chrome|brave|edge) menu|control your music, videos, and more|you|profile.*)$/i;

export function screenList(items = []) {
  const out = [];
  for (const it of items) {
    const name = String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (!name || SECRET_FIELD.test(name)) continue;
    const same = out.find((o) => o.name === name && Math.abs(o.x - it.x) < 12 && Math.abs(o.y - it.y) < 12);
    if (same) { if (PREFER.indexOf(it.type) >= 0 && PREFER.indexOf(it.type) < PREFER.indexOf(same.type)) same.type = it.type; continue; }
    out.push({ type: it.type, name, x: Math.round(it.x), y: Math.round(it.y), ...(it.w && it.h ? { w: Math.round(it.w), h: Math.round(it.h) } : {}) });
  }
  const ui = (o) => BROWSER_UI.test(o.name);
  return [...out.filter((o) => !ui(o)), ...out.filter(ui)].slice(0, 200);
}
const FILLER = new Set('the a an on in at of to button link click tap press icon please my this that'.split(' '));
// The item whose name holds every word of the description (shortest name first).
export function findItem(list, target) {
  const words = String(target || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => !FILLER.has(w)) || [];
  if (!words.length) return null;
  const hits = list.filter((it) => { const n = it.name.toLowerCase(); return words.every((w) => n.includes(w)); });
  return hits.sort((a, b) => a.name.length - b.name.length)[0] || null;
}

function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text));
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

const SENS = 'This looks sensitive. Please do this part yourself.';
const ORD_WORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth', '-1': 'last' };
// Keys that never submit anything: fine even on a password screen.
const SAFE_KEYS = new Set(['esc', 'alt+left', 'alt+right', 'pageup', 'pagedown', 'up', 'down', 'home', 'end', 'f5', 'ctrl+t']);
// After these the page is a different one: the cached screen and its numbers are old.
const PAGE_KEYS = new Set(['enter', 'alt+left', 'alt+right', 'f5', 'ctrl+t', 'ctrl+w']);

export function createScreenPlugin({ driver = windowsDriver, now = Date.now, focusPauseMs = 150 } = {}) {
  return definePluginEntry({
    id: 'screen',
    name: 'Screen control',
    description: 'Look at the laptop screen, click, type and press keys in apps without an API.',
    register(api) {
      const vision = (png, prompt) => {
        if (!api.runtime.vision) throw new Error('Screen understanding needs a Gemini key (GEMINI_API_KEYS).');
        return api.runtime.vision(png, prompt);
      };
      // Every action names the app it is meant for, and only happens if that app is the active window
      // (vision can "find" things that are not there; this stops clicks and typing landing in the wrong app).
      const checkApp = async (app, what) => {
        if (!String(app || '').trim()) return reply(`Which app should I ${what} in? Name it (e.g. "WhatsApp") and make sure it's open in front.`);
        const title = await driver.window();
        if (SENSITIVE.test(title)) return refuse(what);
        if (!title.toLowerCase().includes(String(app).trim().toLowerCase())) return reply(`The active window is "${title}", not ${app}, so I didn't ${what} anything. Bring ${app} to the front and ask again.`);
        return null;
      };
      const APP = { type: 'string', description: 'The app or window this is for, e.g. "WhatsApp" (must be the active window)' };
      const obj = (properties, required = []) => ({ type: 'object', properties, required });
      const str = (description) => ({ type: 'string', description });

      api.registerTool({
        name: 'screen_look',
        description: "Look at the laptop screen and answer a question about it (what's open, what a message says, where something is). Read-only.",
        parameters: obj({ question: str('What to find out, e.g. "what is open?" or "what does the last WhatsApp message say?"') }),
        async execute(_id, { question } = {}) {
          const { png } = await driver.screenshot();
          const text = await vision(png, `You are looking at a screenshot of the user's Windows laptop screen. ${question || 'Briefly describe what is on the screen.'} Answer in 1-3 short sentences. Never read out passwords, card numbers or one-time codes.`);
          return reply(String(text).trim());
        },
      });

      // Pictures for the user (sent to the device that asked). No vision call: nothing is sent to Gemini.
      const show = (png, caption) => {
        if (!api.runtime.showImage) throw new Error("Pictures can't be shown here.");
        api.runtime.showImage({ png, caption });
      };
      api.registerTool({
        name: 'screen_show',
        description: 'Send the user a screenshot (picture) of the whole laptop screen right now, e.g. "show me my laptop screen". Read-only. Never use it for a coding project\'s website or page (homepage, contact page, portfolio) or for "the work you\'re doing / what you\'re building": that is preview_show. Never call the picture anything but the laptop screen.',
        parameters: obj({}),
        async execute() {
          if (SENSITIVE.test(await driver.window())) return refuse('take a screenshot');
          const { png } = await driver.screenshot();
          show(png, 'The laptop screen right now.');
          return reply('Sent a screenshot of the laptop screen. Just say "here it is" — do not describe it.');
        },
      });
      api.registerTool({
        name: 'screen_page',
        description: 'Send the user a screenshot (picture) of a web page. Opens it in a hidden browser that is not signed in. Read-only. For GitHub contributions use github_graph instead.',
        parameters: obj({ url: str('The full web address, starting with https://') }, ['url']),
        async execute(_id, { url } = {}) {
          let parsed;
          try { parsed = new URL(String(url)); } catch { /* checked below */ }
          if (!parsed || !/^https?:$/.test(parsed.protocol)) return reply('I can only take pictures of web addresses (https://…).');
          const { png } = await driver.pageShot(parsed.href);
          show(png, parsed.href);
          return reply(`Sent a picture of ${parsed.href}. Just say "here it is" — do not describe it.`);
        },
      });

      api.registerTool({
        name: 'screen_focus',
        description: 'Bring an open app or window to the front (e.g. "WhatsApp") before clicking or typing in it. Use open_app if it is not open yet.',
        parameters: obj({ app: str('Part of the window title, e.g. "WhatsApp"') }, ['app']),
        async execute(_id, { app }) {
          if (SENSITIVE.test(app)) return refuse('switch to that');
          return (await driver.focus(app)) ? reply(`${app} is in front now.`) : reply(`${app} isn't open. Open it first (I can do that with open_app).`);
        },
      });

      // The last list shown (screen_items), so "click 3" means what the user and the AI just saw.
      let lastList = null;
      const listed = (n) => (lastList && Date.now() - lastList.at < 5 * 60_000 ? lastList.items[Number(n) - 1] || null : null);
      api.registerTool({
        name: 'screen_items',
        description: 'List what is on the laptop screen in the front window — every link, button, video tile, tab and box with a number (any app or browser, e.g. Brave, Chrome, WhatsApp). Use this first to click, play or open anything visible, then screen_click with its number. Read-only.',
        parameters: obj({ app: { type: 'string', description: 'Optional: the app it should be (e.g. "Brave"); by default the front app that is not Novi' } }),
        async execute(_id, { app }) {
          if (!driver.items) {
            const stop = await checkApp(app, 'look at');
            return stop || reply("I can't list what's on this screen; I'll look at it instead.", { fallback: 'screen_look' });
          }
          const { title, items } = await driver.items();
          if (SENSITIVE.test(title)) return refuse('look at that');
          if (app && !title.toLowerCase().includes(String(app).trim().toLowerCase())) return reply(`The app in front is "${title}", not ${app}. Bring ${app} to the front and ask again.`);
          const list = screenList(items);
          lastList = { title, items: list, at: Date.now() };
          if (!list.length) return reply(`I can't read the items in "${title}". I'll look at it instead.`, { fallback: 'screen_look' });
          return reply(`On "${title}":\n${list.map((it, i) => `${i + 1}. ${KIND[it.type] || String(it.type).toLowerCase()}: ${it.name}`).join('\n')}`, { count: list.length });
        },
      });

      api.registerTool({
        name: 'screen_click',
        description: 'Click something on the laptop screen: n = its number from screen_items (best), or target = what it says / looks like, e.g. "the Send button". Works in any app or browser.',
        parameters: obj({ n: { type: 'number', description: 'Number from the last screen_items list' }, target: str('What to click, in words (when there is no number)'), app: { type: 'string', description: 'Optional: the app (needed only when clicking by a description the list does not have)' } }),
        async execute(_id, { target, n, app }) {
          // The listed app may sit behind Novi's own page: bring it forward, then click.
          const front = async (title) => ((await driver.window()) === title || (await driver.focus(title)));
          const clickIt = async (it, title) => {
            if (SENSITIVE.test(it.name) || SENSITIVE.test(title)) return refuse('click that');
            if (!(await front(title))) return reply(`"${title}" isn't open any more, so I didn't click anything.`);
            { const p = clickPoint(it); await driver.click(p.x, p.y); }
            return reply(`Clicked “${it.name}”.`, { x: it.x, y: it.y });
          };
          if (n !== undefined && n !== null) {
            const it = listed(n);
            if (!it) return reply("I need to list what's on the screen first (screen_items), then click by number.");
            return clickIt(it, lastList.title);
          }
          if (!String(target || '').trim()) return reply('Tell me what to click (or list the screen first and give its number).');
          if (SENSITIVE.test(target)) return refuse('click that');
          // Its name in the front app's accessibility list first: no AI, exact position.
          if (driver.items) {
            try {
              const { title, items } = await driver.items();
              const it = (!app || title.toLowerCase().includes(String(app).trim().toLowerCase())) && findItem(screenList(items), target);
              if (it) return clickIt(it, title);
            } catch { /* look at the screen instead */ }
          }
          const stop = await checkApp(app, 'click');
          if (stop) return stop;
          const { png, width, height } = await driver.screenshot();
          const found = parseJson(await vision(png, `Find "${target}" on this screenshot. Do not guess: only say found if it is clearly visible. Reply with JSON only: {"found": true or false, "point": [y, x] (its centre on a 0-1000 grid), "sensitive": true if it is a password, payment, card, one-time-code or CAPTCHA field}.`));
          if (!found?.found || !Array.isArray(found.point)) return reply(`I couldn't find "${target}" on the screen.`);
          if (found.sensitive) return refuse('click that');
          const { x, y } = toPixels(found.point, width, height);
          await driver.click(x, y);
          return reply(`Clicked "${target}".`, { x, y });
        },
      });

      api.registerTool({
        name: 'screen_type',
        description: 'Type text into whatever currently has focus on the laptop screen (click the field first with screen_click).',
        parameters: obj({ text: str('The text to type'), app: APP }, ['text', 'app']),
        async execute(_id, { text, app }) {
          const stop = await checkApp(app, 'type');
          if (stop) return stop;
          await driver.type(String(text).slice(0, 2000));
          return reply('Typed it.');
        },
      });

      api.registerTool({
        name: 'screen_key',
        description: `Press one key or shortcut on the laptop: ${KEYS.join(', ')}.`,
        parameters: obj({ key: str('e.g. "enter", "tab", "ctrl+s"'), app: APP }, ['key', 'app']),
        async execute(_id, { key, app }) {
          const name = normKey(key);
          if (!KEY_CODES[name]) return reply(`I can't press "${key}". I can press: ${KEYS.join(', ')}.`);
          const stop = await checkApp(app, 'press keys');
          if (stop) return stop;
          await driver.key(name);
          return reply(`Pressed ${name}.`);
        },
      });

      // ── Screen Mode (2026-10-29): "start screen control", then one short voice command after another,
      // no card per click (starting it was the yes). The accessibility list first, vision only for what
      // it can't see. Money screens: never; deleting-like clicks: the voice PIN; sends/publishing: a yes.
      const mode = createSession({ now });
      let seen = null; // the front app as last read { title, raw, list, at }, good for 60 s
      let offer = null; // "Spotify isn't open. Should I open it?" → { run, say } or { intent }, 60 s
      let lastDone = null; // { what, undo } for "what did you just do" / "undo that"
      let lastWin = { title: '', hwnd: null }; // the window the last step was in (log, undo)
      const look = async (fresh = false) => {
        if (!fresh && seen && now() - seen.at < 60_000) return seen;
        const { title, hwnd = null, items } = await driver.items();
        seen = { title, hwnd, raw: items, list: screenList(items), at: now() };
        lastWin = { title, hwnd };
        return seen;
      };
      const stale = () => { seen = null; };
      const handleOf = (title) => [seen, lastList, lastWin].find((w) => w?.hwnd && w.title === title)?.hwnd || null;
      // The working window in front, checked — never trusted (live 2026-10-29: AppActivate said yes while
      // Chrome kept the foreground, so a key could have gone anywhere). By its handle when known (titles
      // change while typing: Notepad renames a new tab after its first line), else laptop-control's focus
      // then AppActivate by title. Nothing is clicked, typed or pressed unless it really is in front.
      const onTop = async (title, hwnd = handleOf(title)) => {
        if (hwnd && driver.front && driver.focusHandle) {
          if ((await driver.front()).hwnd === hwnd) return true;
          return driver.focusHandle(hwnd);
        }
        if ((await driver.window()) === title) return true;
        const control = await callTool('laptop_window', { app: title, do: 'focus' }).catch(() => null);
        if (!control || control.error) await driver.focus(title);
        for (let i = 0; i < 4; i++) {
          if ((await driver.window()) === title) return true;
          await new Promise((r) => setTimeout(r, focusPauseMs));
        }
        return false;
      };
      const callTool =(name, params) => (api.runtime.callTool ? api.runtime.callTool(name, params) : Promise.resolve({ error: "I can't reach the laptop's window controls." }));
      const logFile = api.runtime?.dataDir ? path.join(api.runtime.dataDir, 'screen', 'history.jsonl') : null;
      const log = (entry) => {
        if (!logFile) return;
        try {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
          if (fs.statSync(logFile).size > 300_000) fs.writeFileSync(logFile, `${fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-500).join('\n')}\n`);
        } catch (err) { api.logger?.warn?.(`[screen] history: ${err.message}`); }
      };
      const ask = (note, next) => { offer = { ...next, at: now() }; return { note }; };
      const listOffer = (note) => ask(`${note} Should I list the screen items?`, { intent: { do: 'list' } });
      // The risk of a click as the words and the screen say it (the gate and the click agree on it).
      const clickTarget = async (intent) => {
        if (intent.n != null) return listed(intent.n);
        if (!driver.items || !intent.target) return null;
        try { return findTarget((await look()).list, intent.target); } catch { return null; }
      };
      const riskOf = async (intent) => {
        if (intent.do !== 'click') return { level: null };
        const it = await clickTarget(intent);
        const name = it?.name || intent.target || '';
        const level = [clickRisk(name), clickRisk(intent.target || '')].sort((a, b) => riskRank(b) - riskRank(a))[0];
        return { level, name, title: intent.n != null ? lastList?.title : seen?.title };
      };
      const clickAt = async (it, title, allowed) => {
        const risk = clickRisk(it.name);
        if (risk === 'money') return { note: SENS };
        if (riskRank(risk) > riskRank(allowed)) return { note: `That's “${it.name}”. Say “click ${it.name.toLowerCase()}” and I'll check with you first.` };
        if (!(await onTop(title))) return { note: `"${shortTitle(title)}" isn't open any more, so I didn't click anything.` };
        { const p = clickPoint(it); await driver.click(p.x, p.y); }
        stale();
        if (it.type === 'Hyperlink') lastList = null; // a link opens another page: the old numbers are gone
        return { note: `Clicked ${it.name}.`, target: it.name, done: { what: `clicked ${it.name}`, undo: it.type === 'Hyperlink' ? { key: 'alt+left' } : null } };
      };
      const byVision = async (title, prompt) => {
        if (!(await onTop(title))) return null;
        const { png, width, height } = await driver.screenshot();
        const found = parseJson(await vision(png, `${prompt} Do not guess: only say found if it is clearly visible. Reply with JSON only: {"found": true or false, "point": [y, x] (its centre on a 0-1000 grid), "label": "the text on it, if any", "sensitive": true if it is a password, payment, card, one-time-code or CAPTCHA field}.`));
        if (!found?.found || !Array.isArray(found.point)) return null;
        return { ...toPixels(found.point, width, height), name: String(found.label || '').slice(0, 60), sensitive: Boolean(found.sensitive) };
      };

      const act = async (intent) => {
        switch (intent.do) {
          case 'look': {
            const s = await look();
            if (sensitiveScreen(s.title, s.raw)) return { note: SENS };
            if (!(await onTop(s.title))) return { note: `I can't bring "${shortTitle(s.title)}" to the front.` };
            const { png } = await driver.screenshot();
            return { note: String(await vision(png, "You are looking at a screenshot of the user's Windows laptop screen. Briefly say what is open and the main things on it, in 1-2 short sentences. Never read out passwords, card numbers or one-time codes.")).trim(), vision: true };
          }
          case 'show': {
            if (SENSITIVE.test(await driver.window())) return { note: SENS };
            const { png } = await driver.screenshot();
            show(png, 'The laptop screen right now.');
            return { note: "Here's the screen." };
          }
          case 'list': {
            const s = await look(true);
            if (sensitiveScreen(s.title, s.raw)) return { note: SENS };
            lastList = { title: s.title, hwnd: s.hwnd, items: s.list, at: Date.now() };
            if (!s.list.length) return ask(`I can't read the items in "${shortTitle(s.title)}". Should I look at it instead?`, { intent: { do: 'look' } });
            return { note: `${s.list.length} things on ${shortTitle(s.title)}. Say “click” and a number.\n${s.list.map((it, i) => `${i + 1}. ${KIND[it.type] || String(it.type).toLowerCase()}: ${it.name}`).join('\n')}` };
          }
          case 'click': {
            const { level } = await riskOf(intent);
            if (intent.n != null) {
              const it = listed(intent.n);
              if (!it) return listOffer(`I don't have a number ${intent.n}.`);
              if (sensitiveScreen(lastList.title, seen && seen.title === lastList.title ? seen.raw : [])) return { note: SENS };
              return clickAt(it, lastList.title, level);
            }
            const s = await look();
            if (sensitiveScreen(s.title, s.raw)) return { note: SENS };
            const it = findTarget(s.list, intent.target);
            if (it) return clickAt(it, s.title, level);
            const spot = await byVision(s.title, `Find "${intent.target}" on this screenshot.`);
            if (!spot) return listOffer(`I couldn't find ${intent.target}.`);
            if (spot.sensitive) return { note: SENS };
            const out = await clickAt({ ...spot, name: spot.name || intent.target }, s.title, level);
            return { ...out, vision: true };
          }
          case 'result': {
            const s = await look();
            if (sensitiveScreen(s.title, s.raw)) return { note: SENS };
            const word = ORD_WORD[intent.n] || `number ${intent.n}`;
            let it = pickResult(s.list, intent.n);
            let usedVision = false;
            if (!it) {
              usedVision = true;
              const spot = await byVision(s.title, `Find the ${word} search result, video or list entry (counting from the top) on this screenshot.`);
              if (!spot) return ask(`The ${word} result isn't visible. Should I scroll down?`, { intent: { do: 'scroll', dir: 'down', times: 1 } });
              if (spot.sensitive) return { note: SENS };
              it = { ...spot, name: spot.name || `the ${word} result`, type: 'Hyperlink' };
            }
            const out = await clickAt(it, s.title, null);
            return out.target ? { ...out, note: `Opened the ${word} result.`, vision: usedVision } : out;
          }
          case 'type': {
            if (secretWords(intent.text) || secretWords(intent.target)) return { note: "I can't type passwords aloud. Please type it yourself." };
            const s = await look();
            if (sensitiveScreen(s.title, s.raw)) return { note: SENS };
            const box = intent.n != null ? listed(intent.n) : intent.target ? findTarget(s.list, intent.target) : null;
            if ((intent.n != null || intent.target) && !box) return listOffer(`I couldn't find ${intent.target || `box ${intent.n}`}.`);
            if (!(await onTop(s.title))) return { note: `I can't bring "${shortTitle(s.title)}" to the front.` };
            if (box) { const p = clickPoint(box); await driver.click(p.x, p.y); stale(); }
            await driver.type(String(intent.text).slice(0, 2000));
            return { note: 'Typed it.', target: box?.name || '', done: { what: `typed “${String(intent.text).slice(0, 60)}” in ${shortTitle(s.title)}`, undo: { key: 'ctrl+z' } } };
          }
          case 'key': {
            const name = intent.key;
            if (!KEY_CODES[name]) return { note: `I can't press ${name}. I can press Enter, Escape, Tab, Space, the arrows, Page Up and Page Down.` };
            const s = await look();
            if (!SAFE_KEYS.has(name) && sensitiveScreen(s.title, s.raw)) return { note: SENS };
            if (!(await onTop(s.title))) return { note: `I can't bring "${shortTitle(s.title)}" to the front.` };
            for (let i = 0; i < Math.min(intent.times || 1, 10); i++) await driver.key(name);
            if (PAGE_KEYS.has(name)) { stale(); lastList = null; } else stale();
            const label = KEY_LABEL[name] || name;
            return { note: intent.say || `Pressed ${label}${intent.times > 1 ? ` ${intent.times} times` : ''}.`, target: label, done: { what: intent.say ? intent.say.replace(/\.$/, '').toLowerCase() : `pressed ${label}`, undo: name === 'ctrl+t' ? { key: 'ctrl+w' } : name === 'alt+left' ? { key: 'alt+right' } : null } };
          }
          case 'scroll': {
            const notches = (intent.dir === 'down' ? -3 : 3) * Math.min(intent.times || 1, 10);
            await driver.scroll(notches);
            stale();
            return { note: `Scrolled ${intent.dir}.`, done: { what: `scrolled ${intent.dir}`, undo: { scroll: -notches } } };
          }
          case 'window': {
            if (intent.action === 'close') return { note: 'Closing it.', run: { tool: 'laptop_window', args: { app: 'this', do: 'close' } }, say: 'Closed.' };
            const out = await callTool('laptop_window', { app: 'this', do: intent.action });
            if (out?.error) return { note: out.error };
            stale(); lastList = null;
            const label = String(out?.note || '').replace(/^(?:Minimized|Maximized)\s+|\.$/g, '');
            return { note: intent.action === 'minimize' ? 'Minimized.' : 'Maximized.', target: label, done: { what: `${intent.action}d ${label || 'the window'}`, undo: intent.action === 'minimize' && label ? { tool: 'laptop_window', args: { app: label, do: 'focus' } } : null } };
          }
          case 'tab': {
            // Ctrl+W in the app in front (browser, Notepad, VS Code…). laptop_tab only knows browsers, and
            // would close a tab in some other window when Notepad is in front (live 2026-10-29).
            const s = await look();
            if (!(await onTop(s.title))) return { note: `I can't bring "${shortTitle(s.title)}" to the front.` };
            await driver.key('ctrl+w');
            stale(); lastList = null;
            return { note: 'Closed the tab.', target: shortTitle(s.title), done: { what: `closed a tab in ${shortTitle(s.title)}`, undo: { key: 'ctrl+shift+t' } } };
          }
          case 'focus':
          case 'open': {
            const app = String(intent.app || '').trim();
            if (!app || /^novi$/i.test(app)) return { note: "That's me. Name the app you want." };
            if (SENSITIVE.test(app)) return { note: SENS };
            const name = capital(app);
            const out = await callTool('laptop_window', { app, do: 'focus' });
            if (!out?.error) {
              stale(); lastList = null;
              // Say which window it was: with two Chrome windows the front-most may not be the one meant
              // (live 2026-10-29: the user's Amazon cart, not Novi's search).
              const page = driver.front ? shortTitle((await driver.front().catch(() => null))?.title || '') : '';
              const which = page && page !== 'the window' && page.toLowerCase() !== app.toLowerCase() ? `: ${page}` : '';
              return { note: `${name} is in front${which}.`, target: name, done: { what: `brought ${name} to the front`, undo: null } };
            }
            if (!out.notFound) return { note: out.error };
            const run = { tool: 'open_app', args: { name: app } };
            if (intent.do === 'focus') return ask(`${name} isn't open. Should I open it?`, { run, say: `${name} is open.` });
            // focus: a newly started app may open behind the app in front (live: Notepad behind Claude).
            return { note: `Opening ${name}.`, run, say: `${name} is open.`, focus: app, fallback: { tool: 'open_website', args: { target: app, on: 'laptop' } } };
          }
          case 'search': {
            const query = String(intent.query || '').trim();
            if (!query) return { note: 'What should I search for?' };
            stale(); lastList = null;
            // focus: the window showing the results becomes the one Screen Mode works in.
            return { note: `Searching for ${query}.`, focus: `${query} - Google Search`, run:{ tool: 'open_website', args: { target: `https://www.google.com/search?q=${encodeURIComponent(query)}`, on: 'laptop' } }, say: `Searching for ${query}.`, ...(intent.open ? { after: `open the ${ORD_WORD[intent.open] || intent.open} result` } : {}) };
          }
          case 'last':
            return { note: lastDone ? `Last I ${lastDone.what}.` : "I haven't done anything on the screen yet." };
          case 'undo': {
            const u = lastDone?.undo;
            if (!u) return { note: "I can't undo that one." };
            const win = lastDone.win || lastWin; // the window it was done in, not whatever is in front now
            if (u.key) {
              if (!win.title || !(await onTop(win.title, win.hwnd))) return { note: `I can't bring "${shortTitle(win.title)}" to the front, so I didn't undo anything.` };
              await driver.key(u.key);
            } else if (u.scroll) await driver.scroll(u.scroll);
            else if (u.tool) { const out = await callTool(u.tool, u.args); if (out?.error) return { note: out.error }; }
            lastDone = null;
            stale();
            return { note: 'Undone.' };
          }
          default:
            return null;
        }
      };

      const sayIt = (note, details = {}) => ({ content: [{ type: 'text', text: note }], details: { note, mode: mode.isOn() ? 'on' : 'off', ...(mode.paused ? { paused: true } : {}), sensitive: true, ...details } });
      const notMine = () => ({ content: [{ type: 'text', text: 'Not a screen command.' }], details: { unknown: true, mode: mode.isOn() ? 'on' : 'off' } });
      // One step: do it, log it, remember it for "what did you just do" / "undo".
      const step = async (intent, said) => {
        const t0 = now();
        let out;
        try { out = await act(intent); } catch (err) { out = { note: `That didn't work: ${String(err.message).slice(0, 120)}.` }; }
        if (!out) return null;
        log({ at: new Date().toISOString(), said, window: lastWin.title || lastList?.title || '', action: intent.do, target: out.target || '', vision: Boolean(out.vision), result: out.note, ms: now() - t0 });
        if (out.done) lastDone = { ...out.done, win: lastWin };
        return out;
      };
      const asDetails = (out) => ({ ...(out.run ? { run: out.run, say: out.say } : {}), ...(out.focus ? { focus: out.focus } : {}),...(out.fallback ? { fallback: out.fallback } : {}), ...(out.after ? { after: out.after } : {}) });
      const STARTED = "Screen control is on. I'll follow your voice commands. Say 'stop screen control' to end it.";

      api.registerTool({
        name: 'screen_command',
        description: 'Screen Mode: one spoken screen command ("click 3", "open the second result", "type hello", "press enter", "scroll down", "switch to Chrome", "stop screen control"). Starts with "start screen control".',
        parameters: obj({ text: str('What the user said') }, ['text']),
        async execute(_id, { text } = {}) {
          const intent = parseScreenCommand(text);
          if (intent?.do === 'start') { mode.start(); offer = null; stale(); return sayIt(STARTED); }
          if (!intent || !mode.isOn()) return notMine();
          mode.touch();
          if (intent.do === 'stop') { mode.stop(); offer = null; return sayIt('Screen control is off.'); }
          if (intent.do === 'pause') { mode.pause(true); return sayIt('Screen control is paused. Say "resume screen control" to go on.'); }
          if (intent.do === 'resume') { mode.pause(false); return sayIt("I'm listening for screen commands again."); }
          if (mode.paused) return notMine();
          const pending = offer && now() - offer.at < 60_000 ? offer : null;
          if (intent.do === 'yes' || intent.do === 'no') {
            if (!pending) return notMine();
            offer = null;
            if (intent.do === 'no') return sayIt('Okay.');
            if (pending.run) return sayIt(pending.say, { run: pending.run, say: pending.say });
            const out = await step(pending.intent, text);
            return sayIt(out.note, asDetails(out));
          }
          offer = null;
          const out = await step(intent, text);
          if (!out) return notMine();
          return sayIt(out.note, asDetails(out));
        },
      });
      api.registerTool({
        name: 'screen_state',
        description: 'Whether Screen Mode is on, the app in front as last read, and the last screen action. Read-only.',
        parameters: obj({}),
        async execute() {
          const on = mode.isOn();
          return reply(on ? `Screen control is ${mode.paused ? 'paused' : 'on'}${seen ? `; in front: ${shortTitle(seen.title)}` : ''}${lastDone ? `; last I ${lastDone.what}` : ''}.` : 'Screen control is off.', { on, paused: mode.paused, window: seen?.title || null, last: lastDone?.what || null });
        },
      });
      // The same steps for the AI (each asks once, see the gate below; the voice route doesn't need them).
      const forAI = (out) => reply(out.run ? `${out.note} Now call ${out.run.tool} with ${JSON.stringify(out.run.args)}${out.after ? `, then screen_open_result` : ''}.` : out.note, asDetails(out));
      const wrap = (name, description, properties, required, toIntent) => api.registerTool({
        name, description, parameters: obj(properties, required),
        async execute(_id, params = {}) {
          const intent = toIntent(params);
          if (intent.do === 'start') { mode.start(); stale(); return reply(STARTED, { mode: 'on' }); }
          if (intent.do === 'stop') { mode.stop(); return reply('Screen control is off.', { mode: 'off' }); }
          return forAI(await step(intent, name));
        },
      });
      const num = { type: 'number' };
      wrap('screen_mode_start', 'Turn on Screen Mode: after this the user\'s screen commands run one after another without a question each.', {}, [], () => ({ do: 'start' }));
      wrap('screen_mode_stop', 'Turn off Screen Mode.', {}, [], () => ({ do: 'stop' }));
      wrap('screen_open_result', 'Open the n-th visible search result / video / link (1 = first, -1 = last) in the app in front.', { n: num }, ['n'], ({ n }) => ({ do: 'result', n: Number(n) || 1 }));
      wrap('screen_minimize', 'Minimize the app window in front (not Novi).', {}, [], () => ({ do: 'window', action: 'minimize' }));
      wrap('screen_maximize', 'Maximize the app window in front (not Novi).', {}, [], () => ({ do: 'window', action: 'maximize' }));
      wrap('screen_scroll', 'Scroll the app in front up or down.', { direction: { type: 'string', enum: ['up', 'down'] }, times: num }, ['direction'], ({ direction, times }) => ({ do: 'scroll', dir: direction === 'up' ? 'up' : 'down', times: Number(times) || 1 }));
      wrap('screen_search', 'Search the web for something in the laptop\'s browser.', { query: str('What to search for') }, ['query'], ({ query }) => ({ do: 'search', query }));
      wrap('screen_open_search_result', 'Search the web in the laptop\'s browser, then open the n-th result.', { query: str('What to search for'), n: num }, ['query'], ({ query, n }) => ({ do: 'search', query, open: Number(n) || 1 }));
      const WRAPPED = new Set(['screen_open_result', 'screen_minimize', 'screen_maximize', 'screen_scroll', 'screen_search', 'screen_open_search_result', 'screen_mode_start']);

      // Screen control never deletes (live 2026-10-17: Delete in File Explorer removed a folder with no
      // PIN). Deleting files goes through file_delete, which asks for the PIN.
      const NO_DELETE = { block: true, blockReason: "I don't delete things with screen control. Ask me to delete the file or folder by name — that asks for your PIN (file_delete)." };
      // Delete keys only where they edit text; anywhere else (File Explorer windows are titled with just
      // the folder's name) they could delete files.
      const textApp = (app) => /notepad|word|code|cursor|antigravity|kiro|chrome|edge|firefox|brave|whatsapp|telegram|discord|slack|excel|powerpoint|docs|terminal|obsidian|notion/i.test(String(app || ''));
      // Screen Mode: started by the user's own words = no card per step. Still: money never, deleting-like
      // clicks the voice PIN, sending / publishing an explicit yes, and the AI choosing a step asks once.
      const modeGate = async (toolName, params, direct) => {
        const intent = toolName === 'screen_command' ? parseScreenCommand(params.text)
          : toolName === 'screen_open_result' ? { do: 'result' } : { do: toolName === 'screen_mode_start' ? 'start' : 'other' };
        if (!intent) return undefined;
        if (toolName === 'screen_command' && !mode.isOn() && intent.do !== 'start') return undefined;
        const approve = (title, description, extra = {}) => ({ requireApproval: { title, description, severity: 'warning', category: 'screen', grantable: false, ...extra } });
        const risk = await riskOf(intent);
        const where = shortTitle(risk.title || seen?.title || '');
        if (risk.level === 'money') return { block: true, blockReason: SENS };
        if (risk.level === 'destroy') return approve(`Click “${risk.name}” in ${where}`, 'This could delete or change something for good. Say your voice PIN to go ahead, or say no.', { pin: true });
        if (risk.level === 'publish') return approve(`Click “${risk.name}” in ${where}`, 'This may send or publish something.');
        if (intent.do === 'key' && intent.key === 'enter') {
          const title = seen?.title || lastWin.title; // the last read: no new read just to ask
          if (chatApp(title)) return approve(`Press Enter in ${shortTitle(title)}`, 'This may send the message.');
        }
        if (!direct) return approve(intent.do === 'start' ? 'Start screen control' : `Screen: ${String(params.text || toolName).slice(0, 80)}`, '', { grantable: true });
        return undefined;
      };
      api.on('before_tool_call', ({ toolName, params, direct }) => {
        if (toolName === 'screen_command' || WRAPPED.has(toolName)) return modeGate(toolName, params || {}, direct);
        if (toolName === 'screen_key' && /^(?:shift\+)?(?:ctrl\+)?(?:delete|del)$|^ctrl\+d$/i.test(normKey(params.key)) && !textApp(params.app)) return NO_DELETE;
        const clickWhat = toolName === 'screen_click' ? String(params.target || listed(params.n)?.name || (params.n ? `item ${params.n}` : '')) : '';
        if (toolName === 'screen_click' && /\b(?:delete|remove|recycle bin|trash|move to bin|permanently)\b/i.test(clickWhat)) return NO_DELETE;
        const approve = (title, description = '') => ({ requireApproval: { title, description, severity: 'warning', category: 'screen', grantable: true } });
        if (toolName === 'screen_click') return approve(`Click “${clickWhat}”`, params.app ? `in ${params.app}` : '');
        if (toolName === 'screen_type') return approve('Type text on screen', String(params.text || '').slice(0, 300));
        if (toolName === 'screen_key') return approve(`Press ${normKey(params.key)}`);
        return undefined;
      });
    },
  });
}

export default createScreenPlugin();
