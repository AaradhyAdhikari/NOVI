// The done-check's test page: hidden Edge (its own empty profile) over the DevTools protocol. Only the
// project's own site is let through — every request to another host is blocked, so a check can never
// send a real email, payment or form to the internet. Page errors are collected as the "why".
import { launchEdge, connect as connectCdp } from '../screen/cdpShot.js';

export const PHONE = { width: 390, height: 844, mobile: true, scale: 2 };
export const DESKTOP = { width: 1280, height: 800, mobile: false, scale: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function allowedRequest(url, origin) {
  const u = String(url || '');
  return u === origin || u.startsWith(`${origin}/`) || /^(?:data|blob|about):/i.test(u);
}

// The page's controls, numbered (≤ 60, visible only), each tagged so a step can find it again.
const CONTROLS = `(() => {
  const els = [...document.querySelectorAll('input,button,select,textarea,a[href],[role=button]')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.type !== 'hidden'; }).slice(0, 60);
  return els.map((e, i) => {
    e.setAttribute('data-novi-n', String(i + 1));
    const label = (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || e.innerText || e.value || e.name || '';
    const select = e.tagName === 'SELECT';
    return { n: i + 1, tag: e.tagName.toLowerCase(), type: e.type || '', label: String(label).trim().slice(0, 80),
      ...(select ? { options: [...e.options].map((o) => o.text).slice(0, 20) } : { value: String(e.value || '').slice(0, 40) }) };
  });
})()`;

// One step in the page: type into / click / pick an option of a numbered control.
const ACT = (step) => `((s) => {
  const el = document.querySelector('[data-novi-n="' + s.n + '"]');
  if (!el) return { ok: false, why: 'no control ' + s.n };
  if (s.do === 'click') { el.click(); return { ok: true }; }
  if (s.do === 'type') {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(s.value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (s.do === 'select') {
    const want = String(s.value).trim().toLowerCase();
    const o = [...(el.options || [])].find((x) => x.text.trim().toLowerCase() === want || x.value === s.value);
    if (!o) return { ok: false, why: 'no option ' + s.value };
    el.value = o.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  return { ok: false, why: 'unknown step ' + s.do };
})(${JSON.stringify(step)})`;

export async function openSite(url, { launch = launchEdge, connect = connectCdp, settleMs = 1500, loadMs = 20_000 } = {}) {
  const origin = new URL(url).origin;
  const edge = await launch({});
  let cdp;
  try { cdp = await connect(edge.wsUrl); } catch (err) { edge.close(); throw err; }
  const errors = [];
  const blocked = [];
  cdp.on('Fetch.requestPaused', (p) => {
    if (allowedRequest(p.request?.url, origin)) cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    else {
      blocked.push(p.request?.url);
      cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push(String(d.exception?.description || d.text || 'Uncaught error').split('\n')[0]);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    errors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').trim().slice(0, 200) || 'console.error');
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  return {
    errors,
    blocked,
    // Fresh load at a size (phone / desktop).
    async open(size = PHONE) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale || 1, mobile: Boolean(size.mobile) });
      const loaded = cdp.once('Page.loadEventFired', loadMs);
      await cdp.send('Page.navigate', { url });
      await loaded.catch(() => {});
      if (settleMs) await sleep(settleMs);
    },
    async shot() {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data || '', 'base64');
    },
    text: async () => String((await evaluate('document.body ? document.body.innerText : ""')) || '').slice(0, 4000),
    controls: async () => (await evaluate(CONTROLS)) || [],
    act: async (step) => (await evaluate(ACT(step))) || { ok: false, why: 'the page gave no answer' },
    close() {
      cdp?.close();
      edge.close();
    },
  };
}
