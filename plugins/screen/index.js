import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';

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
  click: (x, y) => ps(['click', String(x), String(y)]),
  type: (text) => ps(['type'], { NOVI_SCREEN_TEXT: String(text) }),
  key: (name) => ps(['key', KEY_CODES[name]]),
  focus: async (app) => (await ps(['focus'], { NOVI_SCREEN_APP: String(app) })) === 'True',
  // A picture of a web page from a hidden Edge (its own empty profile, so not signed in anywhere).
  async pageShot(url) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-page-'));
    const file = path.join(dir, 'page.png');
    try {
      await new Promise((resolve, reject) => execFile(EDGE, [
        // --do-not-de-elevate: when Novi runs with admin rights Edge would otherwise hand off to a
        // normal-rights copy and the screenshot is lost.
        '--headless=new', '--do-not-de-elevate', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`,
        '--window-size=1280,1400', '--virtual-time-budget=10000', `--screenshot=${file}`, url,
      ], { windowsHide: true, timeout: 45_000 }, (err) => (err && !fs.existsSync(file) ? reject(err) : resolve())));
      // msedge.exe can return while a child process is still loading the page: wait for the file
      // (and for it to stop growing).
      let last = -1;
      for (let waited = 0; waited < 25_000; waited += 300) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
        if (size > 0 && size === last) return { png: fs.readFileSync(file) };
        last = size;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("The page didn't load in time, so there's no picture.");
    } finally {
      // Edge's helper processes hold the profile for a moment after it exits; clean up later if needed.
      fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
    }
  },
};
const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');

const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ...details, sensitive: true } });
const refuse = (what) => reply(`I won't ${what} here: it looks like a password, payment, CAPTCHA or system security screen. Please do that part yourself.`);

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
        description: 'Send the user a screenshot (picture) of the laptop screen right now, e.g. "show me the screen", "send me a screenshot". Read-only.',
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
        description: 'Send the user a screenshot (picture) of a web page, e.g. "show me a screenshot of my GitHub contributions" → https://github.com/<username>. Opens it in a hidden browser that is not signed in. Read-only.',
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

      api.registerTool({
        name: 'screen_click',
        description: 'Click an element on the laptop screen described in words, e.g. "the Send button in WhatsApp" or "the New chat button". Use screen_look first if unsure what is on screen.',
        parameters: obj({ target: str('What to click, described so it can be found on screen'), app: APP }, ['target', 'app']),
        async execute(_id, { target, app }) {
          if (SENSITIVE.test(target)) return refuse('click that');
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

      api.on('before_tool_call', ({ toolName, params }) => {
        const approve = (title, description = '') => ({ requireApproval: { title, description, severity: 'warning', category: 'screen', grantable: true } });
        if (toolName === 'screen_click') return approve(`Click “${params.target}”`, params.app ? `in ${params.app}` : '');
        if (toolName === 'screen_type') return approve('Type text on screen', String(params.text || '').slice(0, 300));
        if (toolName === 'screen_key') return approve(`Press ${normKey(params.key)}`);
        return undefined;
      });
    },
  });
}

export default createScreenPlugin();
