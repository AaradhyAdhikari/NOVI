import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { createBridge } from './bridge.js';
import { loadCode } from './pairing.js';
import { isSubmit, isPayment, isCardField, needsPassword, hasCaptcha, needsCode, summarizeForm, pageText } from './rules.js';

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

export function createBrowserPlugin({ bridge = null, showImage = null } = {}) {
  return definePluginEntry({
    id: 'browser',
    name: 'Browser',
    description: 'Open, read, fill and click pages in your everyday Chrome.',
    register(api) {
      let link = bridge;
      if (!link) {
        const file = path.join(api.runtime?.dataDir || 'data', 'browser.json');
        link = createBridge({ port: Number(api.pluginConfig?.port) || 3003, code: loadCode(file), logger: api.logger });
        api.registerService({ id: 'browser-bridge', start: () => link.start().catch((err) => api.logger?.warn?.(`[browser] link not started: ${err.message}`)), stop: () => link.stop() });
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
          try { return await fn(params); } catch (err) { return reply({ error: String(err.message || err) }); }
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
      tool('browser_screenshot', 'Show a picture of the page to the user.', obj({}), async () => {
        const { png } = await link.request('screenshot');
        show({ png: Buffer.from(png, 'base64'), caption: page?.title || 'Chrome' });
        return reply({ note: 'Here it is.' });
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
