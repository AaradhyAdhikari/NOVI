import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { createBridge } from './bridge.js';
import { loadCode, newCode } from './pairing.js';
import { fileURLToPath } from 'node:url';
import { createWebDriver, zipForSend } from './whatsapp.js';
import { createAppDriver } from './whatsappApp.js';
import { createControlWorker } from '../laptop-control/worker.js';
import { findWindows } from '../laptop-control/windows.js';
import fs from 'node:fs';
// The extension version in Novi's folder (an older one in Chrome is told to reload itself).
const extensionVersion = () => { try { return JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')).version; } catch { return null; } };
import { isSubmit, isPayment, isCardField, needsPassword, hasCaptcha, needsCode, summarizeForm, pageText, plainError } from './rules.js';

// Novi in the user's everyday Chrome (through the Novi extension). User's rules (2026-10-15):
// final submits ask first with a summary; payments never; passwords and card details are typed by
// the user; CAPTCHAs and one-time codes pause; a phone that asked gets a screenshot with every
// question and pause. Page content is website data for the AI, never instructions.
const PAYMENT = "This is a payment. I'll stop here; please finish it yourself.";
const PAUSES = [
  [needsPassword, 'password', 'Type your password on the laptop and say done.'],
  [hasCaptcha, 'captcha', "There's a CAPTCHA — please solve it and say done."],
  [needsCode, 'code', 'Type the code you got and say done.'],
];
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const fromPhone = (from) => Boolean(from && typeof from === 'object' && from.deviceId);
const item = (page, n) => (page?.items || []).find((it) => it.n === Number(n));

const PREPARED_MS = 5 * 60_000;
const sizeOf = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const orList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]);

export function createBrowserPlugin({ bridge = null, showImage = null, webDriver = null, appDriver = null, appOpen = null, now = () => Date.now() } = {}) {
  return definePluginEntry({
    id: 'browser',
    name: 'Browser',
    description: 'Open, read, fill and click pages in your everyday Chrome.',
    register(api) {
      let link = bridge;
      if (!link) {
        const file = path.join(api.runtime?.dataDir || 'data', 'browser.json');
        // A tap on a card's Windows notification (the extension shows it) answers the card (app.js answerCard).
        const onEvent = (e) => (e.event === 'card' ? api.runtime?.answerCard?.(String(e.id || ''), String(e.action || '')) : null);
        link = createBridge({ port: Number(api.pluginConfig?.port) || 3003, code: loadCode(file), logger: api.logger, wantVersion: extensionVersion(), onEvent });
        // Settings → Browser (laptop-only routes in app.js) read and rotate the pairing code here.
        if (api.runtime) {
          // Every waiting card as a Windows notification on the laptop (user, 2026-10-28), cleared once answered.
          api.runtime.laptopNotify = async (alert) => { if (link.connected()) await link.request('notify', alert); };
          api.runtime.laptopNotifyClear = async (id) => { if (link.connected()) await link.request('notify_clear', { id }); };
          api.runtime.browserStatus = () => ({ connected: link.connected(), code: loadCode(file), version: link.version || null });
          api.runtime.browserNewCode = () => { const c = newCode(file); link.setCode(c); return c; };
        }
        api.registerService({ id: 'browser-bridge', start: () => link.start().catch((err) => api.logger?.warn?.(`[browser] link not started: ${err.message}`)), stop: () => link.stop() });
        // Novi's work window back in the taskbar (Chrome restored it, a session came back…): hidden again.
        let keepHidden = null;
        api.registerService({
          id: 'browser-hide-work',
          start() { keepHidden = setInterval(() => { if (link.connected()) hideWork(); }, 30_000); keepHidden.unref?.(); },
          stop() { clearInterval(keepHidden); },
        });
      }
      // Novi's one Chrome work window ("Novi work - Google Chrome", extension 1.9.0) out of the taskbar and
      // Alt+Tab (live 2026-10-22: minimized work windows still showed there). Done by laptop control.
      function hideWork() { Promise.resolve(api.runtime?.hideWindows?.('Novi work - ')).catch(() => {}); }
      // Other plugins (the orchestrator driving ChatGPT / Gemini) use the same Chrome link. A job tab
      // opening may bring the work window up: hide it now and once more when the page has settled.
      if (api.runtime) {
        api.runtime.browserRequest = (cmd, args = {}, opts) => link.request(cmd, args, opts).then((out) => {
          if (cmd === 'open' && args.slot) { hideWork(); setTimeout(hideWork, 1500).unref?.(); }
          return out;
        });
      }
      const show = (img) => (showImage || api.runtime?.showImage)?.(img);
      let page = null;
      let lastFrom = 'local';

      async function screenshotToPhone(caption) {
        if (!fromPhone(lastFrom)) return;
        try { const { png } = await link.request('screenshot'); show({ png: Buffer.from(png, 'base64'), caption }); } catch { /* the question still stands */ }
      }
      async function read() {
        page = await link.request('read');
        const pause = PAUSES.find(([test]) => test(page));
        if (pause) await screenshotToPhone(pause[2]);
        return reply({ page: pageText(page), ...(pause ? { pause: pause[1], note: pause[2] } : {}) });
      }
      const tool = (name, description, parameters, fn) => api.registerTool({
        name, description, parameters,
        async execute(_id, params = {}) {
          try { return await fn(params); } catch (err) { return reply({ error: plainError(err.message || err) }); }
        },
      });

      tool('browser_open', 'Open a web page in the user\'s Chrome (new tab) and read it.', obj({ url: { type: 'string' } }, ['url']),
        async ({ url }) => { await link.request('open', { url: /^https?:\/\//i.test(url) ? url : `https://${url}`, newTab: true }); return read(); });
      tool('browser_read', 'Read the page open in Chrome now: numbered items you can click or type into, and the page text.', obj({}), () => read());
      tool('browser_click', 'Click item [n] of the last page read.', obj({ n: { type: 'number' } }, ['n']),
        async ({ n }) => { await link.request('click', { n }); return read(); });
      tool('browser_type', 'Type text into field [n]. Never passwords or card details — the user types those.', obj({ n: { type: 'number' }, text: { type: 'string' } }, ['n', 'text']),
        async ({ n, text }) => {
          const it = item(page, n);
          if (it && String(it.type).toLowerCase() === 'password') return reply({ error: "I don't type passwords. Type it on the laptop and say done." });
          if (it && isCardField(it)) return reply({ error: "I don't type card or UPI details. Please type them yourself." });
          await link.request('type', { n, text });
          return read();
        });
      tool('browser_select', 'Choose an option in dropdown [n].', obj({ n: { type: 'number' }, option: { type: 'string' } }, ['n', 'option']),
        async ({ n, option }) => { await link.request('select', { n, option }); return read(); });
      tool('browser_key', 'Press a key in the page: Enter, Escape or Tab.', obj({ key: { type: 'string', enum: ['Enter', 'Escape', 'Tab'] } }, ['key']),
        async ({ key }) => { await link.request('key', { key }); return read(); });
      tool('browser_scroll', 'Scroll the page up or down.', obj({ dir: { type: 'string', enum: ['up', 'down'] } }, ['dir']),
        async ({ dir }) => { await link.request('scroll', { dir }); return read(); });
      tool('browser_back', 'Go back one page.', obj({}), async () => { await link.request('back'); return read(); });
      tool('browser_tabs', 'List the open Chrome tabs.', obj({}), async () => reply({ tabs: (await link.request('tabs')).tabs || [] }));
      tool('browser_switch', 'Switch to a Chrome tab by its id.', obj({ tabId: { type: 'number' } }, ['tabId']),
        async ({ tabId }) => { await link.request('switch', { tabId }); return read(); });
      // WhatsApp (Web through the extension, or the desktop app): prepare finds and checks the
      // chat and attaches; send asks "Send X to <checked name>?" and only then presses Send.
      let worker = null;
      const controlWorker = () => (worker ||= createControlWorker({ script: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'laptop-control', 'control.ps1') }));
      const log = (m) => api.logger?.info?.(m) ?? api.logger?.log?.(m);
      const web = webDriver || createWebDriver({ bridge: link, log });
      let appD = appDriver;
      const app = () => (appD ||= createAppDriver({ worker: controlWorker(), vision: (png, prompt) => api.runtime.vision(png, prompt), log }));
      const appIsOpen = appOpen || (async () => { try { return findWindows((await controlWorker().run('windows', {})).windows || [], 'whatsapp').length > 0; } catch { return false; } });
      let prepared = null; // { driver, name, what, via, at }

      tool('whatsapp_prepare', 'Get a WhatsApp message ready for ONE person: finds the chat, checks it is the right person, attaches a file or folder (zipped) and/or types the text. Then call whatsapp_send — the user is asked before anything is sent. via: "app" or "web" only if the user said so.',
        obj({ to: { type: 'string' }, text: { type: 'string' }, path: { type: 'string', description: 'Full path of a file or folder to send' }, via: { type: 'string', enum: ['web', 'app'] } }, ['to']),
        async ({ to, text, path: target, via }) => {
          prepared = null;
          if (!text && !target) return reply({ error: 'What should I send?' });
          const file = target ? zipForSend(target) : null;
          // WhatsApp Web in a background Chrome tab whenever Chrome is connected (fast, off the screen);
          // the desktop app only when asked for, Chrome isn't connected, or Web isn't signed in yet.
          let useApp = via === 'app' || (via !== 'web' && !link.connected());
          let driver = useApp ? app() : web;
          let r = await driver.prepare({ to, text, file });
          if (!useApp && r.pause === 'qr' && via !== 'web' && await appIsOpen()) {
            useApp = true;
            driver = app();
            r = await driver.prepare({ to, text, file });
          }
          if (r.choose) return reply({ choose: r.choose, note: `Which ${to}: ${orList(r.choose)}?` });
          if (r.pause) return reply({ pause: r.pause, note: r.note });
          if (r.error) return reply({ error: r.error });
          const what = [file && `${file.name} (${sizeOf(file.bytes)})`, text && `"${text}"`].filter(Boolean).join(' with ');
          prepared = { driver, name: r.name, what, via: useApp ? 'app' : 'web', at: now() };
          return reply({ ready: { name: r.name, what, via: prepared.via }, note: `Ready to send ${what} to ${r.name}.` });
        });

      tool('whatsapp_send', 'Send the WhatsApp message prepared by whatsapp_prepare (the user is asked first).', obj({}), async () => {
        const p = prepared;
        prepared = null;
        if (!p) return reply({ error: 'Nothing is ready to send.' });
        const { sent } = await p.driver.send();
        return reply({ sent, note: sent ? `Sent to ${p.name}.` : "WhatsApp didn't confirm it was sent — please check." });
      });

      tool('browser_screenshot', 'Show a picture of the page to the user.', obj({}), async () => {
        const { png } = await link.request('screenshot');
        show({ png: Buffer.from(png, 'base64'), caption: page?.title || 'Chrome' });
        return reply({ note: 'Here it is.' });
      });

      // direct: the user's own words asked for this send, so Novi won't ask (agent) — no picture either.
      api.on('before_tool_call', async ({ toolName, from, direct }) => {
        if (toolName !== 'whatsapp_send') return undefined;
        lastFrom = from || 'local';
        if (!prepared || now() - prepared.at > PREPARED_MS) { prepared = null; return { block: true, blockReason: 'Nothing is ready to send.' }; }
        const title = `Send ${prepared.what} to ${prepared.name}${prepared.via === 'app' ? ' on WhatsApp app' : ''}?`;
        if (fromPhone(lastFrom) && !direct) {
          try {
            const png = prepared.via === 'app' ? await prepared.driver.shot?.() : (await link.request('screenshot')).png;
            if (png) show({ png: Buffer.from(png, 'base64'), caption: title });
          } catch { /* the question still stands */ }
        }
        return { requireApproval: { title, prompt: title, severity: 'warning', category: 'whatsapp', grantable: false } };
      });
      api.on('after_tool_call', async ({ toolName, error }) => {
        if (toolName === 'whatsapp_send' && /declined/i.test(String(error || '')) && prepared) {
          const p = prepared;
          prepared = null;
          await p.driver.cancel().catch(() => {});
        }
      });

      api.on('before_tool_call', async ({ toolName, params = {}, from }) => {
        if (!toolName.startsWith('browser_')) return undefined;
        lastFrom = from || 'local';
        // Never judge a click on a page Novi hasn't read: read it first.
        if (!page && (toolName === 'browser_click' || toolName === 'browser_key')) {
          try { page = await link.request('read'); } catch { return undefined; } // not connected: the run says so
        }
        if (!page) return undefined;
        let target = null;
        if (toolName === 'browser_click') target = item(page, params.n);
        else if (toolName === 'browser_key' && params.key === 'Enter') {
          const focused = item(page, page.focused);
          if (focused?.inForm) target = (page.items || []).find((x) => x.form === focused.form && String(x.type).toLowerCase() === 'submit') || { ...focused, tag: 'button', type: 'submit' };
        }
        if (!target) return undefined;
        if (isPayment(target, page)) return { block: true, blockReason: PAYMENT };
        if (!isSubmit(target, page)) return undefined;
        const title = `${summarizeForm(page, target)}?`;
        await screenshotToPhone(title);
        return { requireApproval: { title, prompt: title, severity: 'warning', category: 'browser', grantable: false } };
      });
    },
  });
}

export default createBrowserPlugin();
