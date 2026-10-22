import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';
import { pageShot } from './pageShot.js';

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
  items: async () => { const out = JSON.parse(await ps(['items'])); return { title: out.title || '', items: [].concat(out.items || []) }; },
  click: (x, y) => ps(['click', String(x), String(y)]),
  type: (text) => ps(['type'], { NOVI_SCREEN_TEXT: String(text) }),
  key: (name) => ps(['key', KEY_CODES[name]]),
  focus: async (app) => (await ps(['focus'], { NOVI_SCREEN_APP: String(app) })) === 'True',
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
    out.push({ type: it.type, name, x: Math.round(it.x), y: Math.round(it.y) });
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

export function createScreenPlugin({ driver = windowsDriver } = {}) {
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
            await driver.click(it.x, it.y);
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

      // Screen control never deletes (live 2026-10-17: Delete in File Explorer removed a folder with no
      // PIN). Deleting files goes through file_delete, which asks for the PIN.
      const NO_DELETE = { block: true, blockReason: "I don't delete things with screen control. Ask me to delete the file or folder by name — that asks for your PIN (file_delete)." };
      // Delete keys only where they edit text; anywhere else (File Explorer windows are titled with just
      // the folder's name) they could delete files.
      const textApp = (app) => /notepad|word|code|cursor|antigravity|kiro|chrome|edge|firefox|brave|whatsapp|telegram|discord|slack|excel|powerpoint|docs|terminal|obsidian|notion/i.test(String(app || ''));
      api.on('before_tool_call', ({ toolName, params }) => {
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
