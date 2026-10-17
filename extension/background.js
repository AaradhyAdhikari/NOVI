// Novi extension: connects to Novi on this laptop (ws://127.0.0.1, pairing code first) and runs
// one command at a time on the active tab: open, read, click, type, select, key, scroll, back,
// tabs, switch, screenshot, attach, waitFor. Novi decides what is allowed; this only does it.
const VERSION = chrome.runtime.getManifest().version;
let ws = null;
let status = 'not connected';

// Why the last connection closed, in words for the popup.
const CLOSED = {
  'wrong code': 'wrong code — copy it again from Novi → Settings → Browser',
  'new code': 'Novi made a new code — paste it here',
  'already connected': 'another Chrome window is already connected to Novi',
};

async function connect() {
  const { code, port = 3003 } = await chrome.storage.local.get(['code', 'port']);
  if (!code) { status = 'no code — paste it from Novi Settings → Browser'; return; }
  if (ws && ws.readyState <= 1) return;
  // Each socket has its own handlers: a late close of an older socket must not touch the new one.
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  ws = sock;
  status = 'connecting…';
  sock.onopen = () => { sock.send(JSON.stringify({ type: 'hello', code, version: VERSION })); status = 'checking the code…'; };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    status = CLOSED[e?.reason] || 'not connected (is Novi running?)';
  };
  sock.onerror = () => {};
  sock.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'welcome') { status = 'connected'; return; }
    if (msg.type === 'reload') return chrome.runtime.reload();
    const { id, cmd, args = {} } = msg;
    try {
      const result = await handle(cmd, args);
      sock.send(JSON.stringify({ id, ok: true, ...result }));
    } catch (err) {
      sock.send(JSON.stringify({ id, ok: false, error: String(err?.message || err) }));
    }
  };
}

chrome.alarms.create('novi', { periodInMinutes: 0.5 }); // keeps the worker awake and reconnects
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener(() => { const old = ws; ws = null; old?.close(); connect(); });
chrome.runtime.onMessage.addListener((m, _s, send) => { if (m === 'status') send({ status, version: VERSION }); });
connect();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No Chrome tab is open.');
  return tab;
}
function loaded(tabId, ms = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); setTimeout(resolve, 400); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
  });
}
async function inPage(tabId, name, args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: (n, a) => window.__novi[n](a), args: [name, args] });
  if (r?.result?.error) throw new Error(r.result.error);
  return r?.result || {};
}

async function handle(cmd, args) {
  if (cmd === 'open') {
    const tab = args.newTab ? await chrome.tabs.create({ url: args.url, active: true }) : await chrome.tabs.update((await activeTab()).id, { url: args.url });
    await chrome.windows.update(tab.windowId, { focused: true });
    await loaded(tab.id);
    return {};
  }
  if (cmd === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
  }
  if (cmd === 'switch') {
    const tab = await chrome.tabs.update(args.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return {};
  }
  const tab = args.tabId ? await chrome.tabs.get(args.tabId) : await activeTab();
  if (cmd === 'screenshot') {
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { png: url.split(',')[1] };
  }
  if (cmd === 'back') { await chrome.tabs.goBack(tab.id); await loaded(tab.id, 5000); return {}; }
  if (cmd === 'waitFor') {
    const until = Date.now() + (args.ms || 10000);
    while (Date.now() < until) {
      const page = await inPage(tab.id, 'read', {});
      if (args.text && page.text?.includes(args.text)) return { found: true };
      if (args.selector && (await inPage(tab.id, 'has', { selector: args.selector })).found) return { found: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { found: false };
  }
  if (['read', 'click', 'type', 'select', 'key', 'scroll', 'attach', 'has', 'query', 'clickSel', 'typeSel'].includes(cmd)) {
    const result = await inPage(tab.id, cmd, args);
    if (cmd === 'click' || cmd === 'key') await loaded(tab.id, 1500);
    return result;
  }
  throw new Error(`unknown command ${cmd}`);
}
