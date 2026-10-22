// Novi extension: connects to Novi on this laptop (ws://127.0.0.1, pairing code first) and runs
// one command at a time on the active tab: open, read, click, type, select, key, scroll, back,
// tabs, switch, screenshot, attach, waitFor. Novi decides what is allowed; this only does it.
importScripts('awake.js'); // stayAwake, also put into Novi's tabs after they load
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
chrome.alarms.onAlarm.addListener(() => closeIdle().catch(() => {}));
// awake.js runs first in every page (it acts only in Novi's work tabs).
chrome.scripting.registerContentScripts?.([{ id: 'novi-awake', matches: ['<all_urls>'], js: ['awake.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true }]).catch(() => { /* already there */ });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// A new pairing code or port: connect again. Nothing else (live 2026-10-22: Novi's tab list in session
// storage closed the connection in the middle of every job).
chrome.storage.onChanged.addListener((changes = {}, area) => {
  if (area !== 'local' || !('code' in changes || 'port' in changes)) return;
  const old = ws; ws = null; old?.close(); connect();
});
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
// Novi's own work (ChatGPT, Gemini, claude.ai) happens in one minimized Chrome window of its own, one tab
// per job ("slot"), reused — also after Novi restarts — and closed after 45 minutes nobody used it (user,
// 2026-10-22: "it opens too many tabs… do all this work in background and not by using my screen").
const IDLE_MS = 45 * 60_000;
const WORK_SITES = /^https:\/\/(chatgpt\.com|gemini\.google\.com|claude\.ai)\//;
const exists = (p) => p.then(() => true, () => false);
// The list lasts through extension updates (local storage: session storage was wiped on every reload and
// Novi's old window was left behind). Chrome reuses tab numbers after a restart, so a tab counts as Novi's
// only when its page carries Novi's mark — never one of your tabs, whatever its number.
async function work() {
  const { noviWork: s = {} } = await chrome.storage.local.get(['noviWork']);
  return { slots: s.slots || {}, used: s.used || {} };
}
const save = (w) => chrome.storage.local.set({ noviWork: w });
function isNoviTab() { try { return sessionStorage.getItem('__noviWork') === '1'; } catch { return false; } }
async function ours(tabId) {
  try { const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: isNoviTab }); return r?.result === true; } catch { return false; }
}
// Novi's one work window opens on its own page, work.html ("Novi work"), which stays its active tab: the
// window's title never changes, so Novi can hide it from the taskbar (live 2026-10-22: two minimized Novi
// windows, "ChatGPT" and "Projects - Claude", still showed in the taskbar). Jobs are tabs behind it.
const WORK_PAGE = chrome.runtime.getURL('work.html');
async function workWindow() {
  const pages = await chrome.tabs.query({ url: WORK_PAGE });
  for (const extra of pages.slice(1)) await chrome.tabs.remove(extra.id).catch(() => {});
  if (pages.length) return pages[0].windowId;
  const win = await chrome.windows.create({ url: WORK_PAGE, state: 'minimized', focused: false });
  // Chrome on Windows opened it shown anyway (behind, but on screen).
  await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
  return win.id;
}
chrome.tabs.onActivated?.addListener(async ({ tabId, windowId }) => {
  const [page] = await chrome.tabs.query({ url: WORK_PAGE, windowId }).catch(() => []);
  if (page && page.id !== tabId) chrome.tabs.update(page.id, { active: true }).catch(() => {});
});
async function openJob(url, slot) {
  const w = await work();
  const home = await workWindow();
  const known = w.slots[slot];
  let tab = null;
  if (known != null && (await ours(known))) {
    // A job tab left in another window (older versions) moves into the one work window.
    if ((await chrome.tabs.get(known)).windowId !== home) await chrome.tabs.move(known, { windowId: home, index: -1 });
    tab = await chrome.tabs.update(known, { url });
  }
  if (!tab) {
    const marked = url.includes('#') ? url : `${url}#novi-work`; // awake.js keeps this tab running while hidden
    tab = await chrome.tabs.create({ windowId: home, url: marked, active: false });
  }
  w.slots[slot] = tab.id;
  w.used[tab.id] = Date.now();
  await save(w);
  return tab;
}
// A command on one of Novi's work tabs: remember it was used, and keep the page awake (stayAwake also
// marks the page as Novi's).
async function touch(tabId) {
  const w = await work();
  if (!Object.values(w.slots).includes(tabId)) return false;
  w.used[tabId] = Date.now();
  await save(w);
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: stayAwake }).catch(() => {});
  return true;
}
async function closeIdle() {
  const w = await work();
  let changed = false;
  for (const [slot, id] of Object.entries(w.slots)) {
    if (Date.now() - (w.used[id] || 0) < IDLE_MS && (await exists(chrome.tabs.get(id)))) continue;
    if (await ours(id)) await chrome.tabs.remove(id).catch(() => {});
    delete w.slots[slot];
    delete w.used[id];
    changed = true;
  }
  if (changed) await save(w);
}
// Novi's work tabs it lost track of (an older version kept its list where an update wiped it): closed.
async function closeOrphans() {
  const mine = new Set(Object.values((await work()).slots));
  for (const t of await chrome.tabs.query({})) {
    if (!mine.has(t.id) && WORK_SITES.test(t.url || '') && (await ours(t.id))) await chrome.tabs.remove(t.id).catch(() => {});
  }
}
// On start: Novi tabs still on the list but in older windows (before 1.9.0 each job could make its own
// window) move into the one work window; the emptied windows close by themselves.
async function tidyWork() {
  await closeOrphans();
  const mine = [];
  for (const id of Object.values((await work()).slots)) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && (await ours(id))) mine.push(t);
  }
  if (!mine.length) return;
  const home = await workWindow();
  for (const t of mine) if (t.windowId !== home) await chrome.tabs.move(t.id, { windowId: home, index: -1 }).catch(() => {});
}
tidyWork().catch(() => {});

async function inPage(tabId, name, args) {
  await touch(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: (n, a) => window.__novi[n](a), args: [name, args] });
  if (r?.result?.error) throw new Error(r.result.error);
  return r?.result || {};
}

async function handle(cmd, args) {
  if (cmd === 'open' && args.slot) {
    const tab = await openJob(args.url, args.slot);
    await loaded(tab.id);
    await touch(tab.id);
    return { tabId: tab.id };
  }
  if (cmd === 'open') {
    // background: a new tab that stays behind the one the user is looking at (WhatsApp sends).
    // tabId: load the page in that tab (an AI site's own tab gets a fresh chat without a new tab).
    const tab = args.tabId ? await chrome.tabs.update(args.tabId, { url: args.url })
      : args.newTab ? await chrome.tabs.create({ url: args.url, active: !args.background }) : await chrome.tabs.update((await activeTab()).id, { url: args.url });
    if (!args.background) await chrome.windows.update(tab.windowId, { focused: true });
    await loaded(tab.id);
    return { tabId: tab.id };
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
  if (['read', 'click', 'type', 'select', 'key', 'scroll', 'attach', 'has', 'query', 'textOf', 'textsOf', 'groups', 'clickSel', 'typeSel'].includes(cmd)) {
    const result = await inPage(tab.id, cmd, args);
    if (cmd === 'click' || cmd === 'key') await loaded(tab.id, 1500);
    return result;
  }
  throw new Error(`unknown command ${cmd}`);
}
