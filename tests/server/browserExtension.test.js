import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (f) => fs.readFileSync(new URL(`../../extension/${f}`, import.meta.url), 'utf8');
// background.js in a fake service worker (importScripts loads awake.js the way Chrome does).
const runBackground = (ctx) => { ctx.importScripts = (f) => vm.runInContext(read(f), ctx); vm.createContext(ctx); vm.runInContext(read('background.js'), ctx); };

describe('Novi Chrome extension (static checks; it runs only in Chrome)', () => {
  it('manifest: MV3 with only the permissions it needs', () => {
    const m = JSON.parse(read('manifest.json'));
    expect(m.manifest_version).toBe(3);
    expect([...m.permissions].sort()).toEqual(['alarms', 'scripting', 'storage', 'tabs']);
    expect(m.host_permissions).toEqual(['<all_urls>']);
    expect(m.background.service_worker).toBe('background.js');
    expect(m.action.default_popup).toBe('popup.html');
  });

  it('scripts are valid JavaScript', () => {
    for (const f of ['background.js', 'page.js', 'popup.js', 'awake.js']) {
      // fileURLToPath, not .pathname: the laptop's folder (ドキュメント, spaces) broke the URL path on Windows.
      expect(() => execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../../extension/${f}`, import.meta.url))]), f).not.toThrow();
    }
  });

  it('connects only to Novi on this laptop, with the code first', () => {
    const bg = read('background.js');
    expect(bg).toMatch(/new WebSocket\(`ws:\/\/127\.0\.0\.1:\$\{port\}`\)/);
    expect(bg).not.toMatch(/wss?:\/\/(?!127\.0\.0\.1)/);
    expect(bg).toMatch(/type: 'hello', code/);
  });

  it('password fields: only "empty or not" leaves the page, and Novi never types into them', () => {
    const page = read('page.js');
    const pwLine = page.split('\n').find((l) => l.includes("type === 'password'") && l.includes('empty'));
    expect(pwLine).toBeTruthy();
    expect(pwLine).not.toMatch(/value:/);
    expect(page).toMatch(/I don't type passwords/);
  });
});

describe('page.js numbering (fake page)', () => {
  function fakePage(els) {
    const document = {
      title: 'T', body: { innerText: '' }, activeElement: null,
      querySelectorAll: (sel) => (sel === 'iframe' ? [] : sel === '[data-novi-n]' ? els.filter((e) => e.attrs['data-novi-n']) : els.filter((e) => e.inDom)),
      querySelector: (sel) => { const m = /data-novi-n="(\d+)"/.exec(sel); return els.find((e) => e.attrs['data-novi-n'] === m?.[1]) || null; },
    };
    const window = {};
    const ctx = { window, document, location: { href: 'https://x.test/' }, getComputedStyle: () => ({ visibility: 'visible' }), Event: class {} };
    vm.runInNewContext(read('page.js'), ctx);
    return window.__novi;
  }
  const el = (label, visible = true) => ({
    label, inDom: true, visible, attrs: {}, clicked: 0, tagName: 'BUTTON', labels: [], innerText: label,
    getClientRects() { return this.visible ? [1] : []; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    scrollIntoView() {}, click() { this.clicked += 1; },
  });

  it('a re-read clears old numbers, so a click hits the item Novi just read', () => {
    const submit = el('Create account');
    const help = el('Help');
    const novi = fakePage([submit, help]);
    novi.read();
    expect(submit.attrs['data-novi-n']).toBe('1');
    submit.visible = false; // the page changed in place: the old button is hidden, still in the page
    const map = novi.read();
    expect(map.items.map((i) => i.label)).toEqual(['Help']);
    novi.click({ n: 1 });
    expect(help.clicked).toBe(1);
    expect(submit.clicked).toBe(0);
  });
  // The orchestrator reads a whole ChatGPT / Gemini answer (2026-10-18): query() cuts text to 80 characters.
  it('textOf: the last visible match, whole, with its line breaks', () => {
    const a = el('first answer');
    const b = el('Step 1\n  code line\nStep 2');
    const hidden = el('old', false);
    const novi = fakePage([a, b, hidden]);
    expect(novi.textOf({ selector: '.answer' })).toEqual({ count: 2, text: 'Step 1\n  code line\nStep 2' });
    expect(fakePage([]).textOf({ selector: '.answer' })).toEqual({ count: 0, text: '' });
    expect(read('background.js')).toMatch(/'textOf'/);
    expect(read('background.js')).toMatch(/args\.tabId \? await chrome\.tabs\.update\(args\.tabId/);
  });
  // The ChatGPT planning chat (2026-10-20): every message, whole, with who wrote it.
  it('textsOf: every visible match, whole, with an attribute; hidden ones left out', () => {
    const q = el('How should the brain work?');
    q.attrs['data-message-author-role'] = 'user';
    const a = el('Plan:\n1. Index\n2. Search');
    a.attrs['data-message-author-role'] = 'assistant';
    const novi = fakePage([q, a, el('gone', false)]);
    expect(novi.textsOf({ selector: '[data-message-author-role]', attr: 'data-message-author-role' })).toEqual({
      items: [{ text: 'How should the brain work?', attr: 'user' }, { text: 'Plan:\n1. Index\n2. Search', attr: 'assistant' }],
    });
    expect(novi.textsOf({ selector: 'x', attrs: ['data-message-author-role', 'data-user-message-bubble'] }).items[0].attrs)
      .toEqual({ 'data-message-author-role': 'user', 'data-user-message-bubble': null });
    expect(read('background.js')).toMatch(/'textsOf'/);
    expect(JSON.parse(read('manifest.json')).version).toBe('1.9.0');
  });
  // claude.ai's project list (2026-10-18): each card's name is its first line, its link the href.
  it('query: first line only and an attribute when asked; plain query as before', () => {
    const a = el('FlexR\nA fitness app\nUpdated 2 days ago');
    a.attrs.href = '/project/0193-a';
    const novi = fakePage([a]);
    expect(novi.query({ selector: 'a', firstLine: true, attr: 'href' })).toEqual({ texts: ['FlexR'], values: ['/project/0193-a'] });
    expect(novi.query({ selector: 'a' })).toEqual({ texts: ['FlexR A fitness app Updated 2 days ago'] });
    // scrollLast: the last match is scrolled into view, so a list that loads more as you scroll shows more.
    let scrolled = 0;
    a.scrollIntoView = () => { scrolled += 1; };
    novi.query({ selector: 'a', firstLine: true, attr: 'href', scrollLast: true });
    expect(scrolled).toBe(1);
  });
});

// The popup said "saved, connecting…" forever, and a socket closed late could wipe out the new
// one (2026-10-17). background.js runs here against a fake chrome + WebSocket.
describe('background.js connection (fake Chrome)', () => {
  function fakeChrome(stored = {}) {
    const sockets = [];
    const listeners = { changed: [], message: [] };
    class FakeSocket {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
      send(d) { this.sent.push(JSON.parse(d)); }
      close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.(); }
      receive(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
      closed(reason = '') { this.readyState = 3; this.onclose?.({ code: 1008, reason }); }
    }
    const store = { ...stored };
    const chrome = {
      runtime: { getManifest: () => ({ version: '1.0.0' }), getURL: (p) => `chrome-extension://novi/${p}`, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener: (f) => listeners.message.push(f) }, reload() {} },
      storage: {
        local: { get: async () => ({ ...store }), set: async (o) => { Object.assign(store, o); for (const f of listeners.changed) f(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: o[k] }])), 'local'); } },
        onChanged: { addListener: (f) => listeners.changed.push(f) },
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      tabs: {}, scripting: {},
    };
    runBackground({ chrome, WebSocket: FakeSocket, setTimeout, clearTimeout, console, JSON, Promise, Error, String });
    const status = () => { let s; listeners.message[0]('status', null, (r) => { s = r.status; }); return s; };
    return { sockets, status, store, chrome, changed: (changes, area) => listeners.changed.forEach((f) => f(changes, area)) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('says connected only after Novi accepts the code', async () => {
    const c = fakeChrome({ code: 'right' });
    await flush();
    c.sockets[0].open();
    expect(c.sockets[0].sent[0]).toMatchObject({ type: 'hello', code: 'right' });
    expect(c.status()).not.toBe('connected');
    c.sockets[0].receive({ type: 'welcome' });
    expect(c.status()).toBe('connected');
  });

  it('a wrong code says so', async () => {
    const c = fakeChrome({ code: 'nope' });
    await flush();
    c.sockets[0].open();
    c.sockets[0].closed('wrong code');
    expect(c.status()).toMatch(/wrong code/i);
  });

  // Live 2026-10-22: Novi's tab list lives in session storage; saving it closed the connection mid-request
  // ("The Novi extension isn't connected") because any storage change counted as a new code.
  it('only a new code or port reconnects; Novi saving its tab list does not', async () => {
    const c = fakeChrome({ code: 'right' });
    await flush();
    c.sockets[0].open();
    c.changed({ slots: { newValue: {} }, used: { newValue: {} } }, 'session');
    c.changed({ other: { newValue: 1 } }, 'local');
    await flush();
    expect(c.sockets).toHaveLength(1);
    c.changed({ code: { newValue: 'new' } }, 'local');
    await flush();
    expect(c.sockets).toHaveLength(2);
  });

  it('saving a new code: the old socket closing late does not wipe out the new one', async () => {
    const c = fakeChrome({ code: 'old' });
    await flush();
    c.sockets[0].open();
    await c.chrome.storage.local.set({ code: 'new' });
    await flush();
    expect(c.sockets).toHaveLength(2);
    c.sockets[1].open();
    c.sockets[1].receive({ type: 'welcome' });
    c.sockets[0].closed(); // the old one's close event arrives last
    expect(c.status()).toBe('connected');
    c.sockets[1].receive({ id: 7, cmd: 'nosuch', args: {} });
    await flush();
    expect(c.sockets[1].sent.at(-1)).toMatchObject({ id: 7, ok: false }); // answers on its own socket
  });
});

// Live 2026-10-22, user: "it opens too many tabs… it should do all this work in background and not by
// using my screen". Novi's own work (ChatGPT, Gemini, claude.ai) now happens in one minimized Chrome
// window, one tab per job, reused (also after Novi restarts), kept awake while hidden, closed when idle.
describe("background.js: Novi's own window (fake Chrome)", () => {
  function workChrome({ before = [], saved = null } = {}) {
    const sockets = [];
    const tabs = new Map();
    const windows = new Map([[1, { id: 1 }]]); // the user's window
    tabs.set(1, { id: 1, windowId: 1, url: 'https://mail.google.com/', active: true }); // the user's own tab
    const marked = new Set(); // tabs whose page carries Novi's mark (sessionStorage __noviWork)
    for (const t of before) { tabs.set(t.id, { windowId: 1, active: false, ...t }); if (t.marked) marked.add(t.id); }
    const local = { code: 'c', ...(saved ? { noviWork: saved } : {}) };
    let nextTab = 10;
    let nextWin = 100;
    const session = {};
    const alarms = [];
    const injected = [];
    const created = [];
    const focused = [];
    const moved = [];
    let clock = 1_000_000;
    class FakeSocket {
      constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
      send(d) { this.sent.push(JSON.parse(d)); }
      close() { this.readyState = 3; }
    }
    const complete = [];
    const chrome = {
      runtime: { getManifest: () => ({ version: '1.9.0' }), getURL: (p) => `chrome-extension://novi/${p}`, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener() {} }, reload() {} },
      storage: {
        local: { get: async () => JSON.parse(JSON.stringify(local)), set: async (o) => { Object.assign(local, JSON.parse(JSON.stringify(o))); } },
        session: { get: async () => JSON.parse(JSON.stringify(session)), set: async (o) => { Object.assign(session, JSON.parse(JSON.stringify(o))); } },
        onChanged: { addListener() {} },
      },
      alarms: { create() {}, onAlarm: { addListener: (f) => alarms.push(f) } },
      windows: {
        create: async (o) => {
          created.push(['window', o]);
          const id = nextWin++;
          windows.set(id, { id, state: 'normal' }); // live 2026-10-22: Chrome on Windows ignored state: 'minimized' here
          const t = { id: nextTab++, windowId: id, url: o.url, active: true };
          tabs.set(t.id, t);
          if (/#novi-work/.test(o.url)) marked.add(t.id);
          return { id, tabs: [t] };
        },
        get: async (id) => { if (!windows.has(id)) throw new Error(`No window with id: ${id}.`); return windows.get(id); },
        update: async (id, o) => { if (o.focused) focused.push(id); Object.assign(windows.get(id), o); return windows.get(id); },
      },
      tabs: {
        create: async (o) => { created.push(['tab', o]); const t = { id: nextTab++, windowId: o.windowId ?? 1, url: o.url, active: o.active !== false }; tabs.set(t.id, t); if (/#novi-work/.test(o.url)) marked.add(t.id); return t; },
        update: async (id, o) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); Object.assign(t, o); return t; },
        get: async (id) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return t; },
        query: async (q = {}) => [...tabs.values()].filter((t) => (!q.url || t.url === q.url) && (q.windowId === undefined || t.windowId === q.windowId)),
        move: async (id, o) => { const t = tabs.get(id); t.windowId = o.windowId; moved.push([id, o.windowId]); return t; },
        onActivated: { addListener() {} },
        remove: async (id) => { const t = tabs.get(id); tabs.delete(id); if (t && ![...tabs.values()].some((x) => x.windowId === t.windowId)) windows.delete(t.windowId); },
        onUpdated: { addListener: (f) => { complete.push(f); setTimeout(() => { for (const id of tabs.keys()) f(id, { status: 'complete' }); }, 0); }, removeListener() {} },
      },
      scripting: {
        executeScript: async (o) => {
          injected.push(o);
          if (!tabs.has(o.target.tabId)) throw new Error('No tab');
          if (o.func?.name === 'isNoviTab') return [{ result: marked.has(o.target.tabId) }];
          if (o.func?.name === 'stayAwake') marked.add(o.target.tabId);
          return [{ result: {} }];
        },
        registerContentScripts: async () => {},
      },
    };
    const fastTimeout = (f, ms) => setTimeout(f, Math.min(ms, 1));
    runBackground({ chrome, WebSocket: FakeSocket, setTimeout: fastTimeout, clearTimeout, console, JSON, Promise, Error, String, Date: { now: () => clock } });
    let id = 0;
    const ask = async (cmd, args = {}) => {
      const s = sockets[0];
      const my = ++id;
      s.onmessage({ data: JSON.stringify({ id: my, cmd, args }) });
      for (let i = 0; i < 200; i++) {
        const r = s.sent.find((m) => m.id === my);
        if (r) return r;
        await new Promise((res) => setTimeout(res, 1));
      }
      throw new Error(`no answer to ${cmd}`);
    };
    const start = async () => { await new Promise((r) => setTimeout(r, 0)); sockets[0].readyState = 1; sockets[0].onopen?.(); sockets[0].onmessage({ data: JSON.stringify({ type: 'welcome' }) }); };
    return { ask, start, tabs, windows, created, focused, injected, session, local, moved, alarm: () => Promise.all(alarms.map((f) => f({ name: 'novi' }))), tick: (ms) => { clock += ms; } };
  }

  it('a job opens in one minimized Novi window, never in your window and never in front', async () => {
    const c = workChrome();
    await c.start();
    const r = await c.ask('open', { url: 'https://chatgpt.com/', slot: 'orchestrator-chatgpt', background: true });
    expect(r.ok).toBe(true);
    // The window opens on Novi's own page (fixed title "Novi work", so Novi can hide it from the taskbar); jobs are tabs in it.
    expect(c.created[0]).toEqual(['window', { url: 'chrome-extension://novi/work.html', state: 'minimized', focused: false }]);
    expect(c.created[1]).toEqual(['tab', { windowId: c.tabs.get(r.tabId).windowId, url: 'https://chatgpt.com/#novi-work', active: false }]);
    expect(c.tabs.get(r.tabId).windowId).not.toBe(1);
    expect(c.windows.get(c.tabs.get(r.tabId).windowId).state).toBe('minimized');
    expect(c.focused).toEqual([]);
  });

  it('the same job reuses its tab (also after Novi restarts); another job gets a second tab in that window', async () => {
    const c = workChrome();
    await c.start();
    const a = await c.ask('open', { url: 'https://chatgpt.com/', slot: 'orchestrator-chatgpt', background: true });
    const again = await c.ask('open', { url: 'https://chatgpt.com/', slot: 'orchestrator-chatgpt', background: true });
    expect(again.tabId).toBe(a.tabId);
    const b = await c.ask('open', { url: 'https://gemini.google.com/app', slot: 'orchestrator-gemini', background: true });
    expect(b.tabId).not.toBe(a.tabId);
    expect(c.tabs.get(b.tabId).windowId).toBe(c.tabs.get(a.tabId).windowId);
    expect(c.created.filter(([k]) => k === 'window')).toHaveLength(1);
    expect(c.created.find(([k]) => k === 'tab')[1]).toMatchObject({ active: false });
  });

  it('you closed the Novi window: the next job makes a new one', async () => {
    const c = workChrome();
    await c.start();
    const a = await c.ask('open', { url: 'https://claude.ai/projects', slot: 'claude-link', background: true });
    const gone = c.tabs.get(a.tabId).windowId;
    c.windows.delete(gone);
    for (const [id, t] of [...c.tabs]) if (t.windowId === gone) c.tabs.delete(id); // closing a window closes its tabs
    const b = await c.ask('open', { url: 'https://claude.ai/projects', slot: 'claude-link', background: true });
    expect(b.ok).toBe(true);
    expect(c.created.filter(([k]) => k === 'window')).toHaveLength(2);
  });

  it('Novi tabs are kept awake while hidden; your own tabs are never touched', async () => {
    const c = workChrome();
    await c.start();
    const a = await c.ask('open', { url: 'https://gemini.google.com/app', slot: 'orchestrator-gemini', background: true });
    const awake = () => c.injected.filter((o) => o.world === 'MAIN' && o.func?.name === 'stayAwake');
    expect(awake().map((o) => o.target.tabId)).toContain(a.tabId);
    await c.ask('has', { selector: 'x', tabId: 1 });
    expect(awake().some((o) => o.target.tabId === 1)).toBe(false);
  });

  it('a Novi tab nobody used for 45 minutes is closed; a busy one stays', async () => {
    const c = workChrome();
    await c.start();
    const old = await c.ask('open', { url: 'https://claude.ai/projects', slot: 'claude-link', background: true });
    c.tick(30 * 60_000);
    const busy = await c.ask('open', { url: 'https://chatgpt.com/', slot: 'chatgpt-plan', background: true });
    c.tick(16 * 60_000);
    await c.alarm();
    expect(c.tabs.has(old.tabId)).toBe(false);
    expect(c.tabs.has(busy.tabId)).toBe(true);
    const back = await c.ask('open', { url: 'https://claude.ai/projects', slot: 'claude-link', background: true });
    expect(back.tabId).not.toBe(old.tabId);
    expect(c.tabs.has(1)).toBe(true); // your tab is never closed
  });

  // The list of Novi's tabs lasts through extension updates (session storage was wiped on every reload,
  // leaving Novi's old window behind). Chrome reuses tab numbers after a restart, so a tab is Novi's only
  // if its page carries Novi's mark — never your tab, whatever number it has.
  it('after Chrome restarts, a saved tab number that is now your tab is never reused or closed', async () => {
    const c = workChrome({ saved: { noviWin: 1, slots: { 'claude-link': 1 }, used: { 1: 0 } } });
    await c.start();
    c.tick(60 * 60_000);
    await c.alarm();
    expect(c.tabs.get(1).url).toBe('https://mail.google.com/');
    const r = await c.ask('open', { url: 'https://claude.ai/projects', slot: 'claude-link', background: true });
    expect(r.tabId).not.toBe(1);
    expect(c.tabs.get(1).url).toBe('https://mail.google.com/');
    expect(c.tabs.get(r.tabId).windowId).not.toBe(1);
  });

  it("Novi's tabs from before an update are kept track of; marked ones it lost track of are closed at start", async () => {
    const c = workChrome({ before: [{ id: 50, url: 'https://claude.ai/projects', marked: true }, { id: 51, url: 'https://claude.ai/projects' }] });
    await c.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(c.tabs.has(50)).toBe(false); // Novi's old tab, no longer on its list
    expect(c.tabs.has(51)).toBe(true); // yours (no mark)
    const a = await c.ask('open', { url: 'https://chatgpt.com/', slot: 'chatgpt-plan', background: true });
    expect(c.local.noviWork.slots['chatgpt-plan']).toBe(a.tabId);
  });

  // Live 2026-10-22: two Novi windows showed in the taskbar ("ChatGPT" and "Projects - Claude").
  it('on start, Novi tabs in older windows move into the one work window at once (no job needed)', async () => {
    const c = workChrome({ before: [{ id: 60, windowId: 7, url: 'https://claude.ai/projects', marked: true }, { id: 61, windowId: 8, url: 'https://chatgpt.com/c/1', marked: true }], saved: { slots: { 'claude-link': 60, 'chatgpt-plan': 61 }, used: { 60: 1_000_000, 61: 1_000_000 } } });
    await c.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(c.created.filter(([k]) => k === 'window')).toHaveLength(1);
    expect(c.tabs.get(60).windowId).toBe(c.tabs.get(61).windowId);
    expect(c.tabs.get(60).windowId).not.toBe(7);
  });

  it('always one work window: a job tab left in another window is moved into it', async () => {
    const c = workChrome({ before: [{ id: 60, windowId: 7, url: 'https://claude.ai/projects', marked: true }], saved: { slots: { 'claude-link': 60 }, used: { 60: 1_000_000 } } });
    c.windows.set(7, { id: 7 });
    await c.start();
    const a = await c.ask('open', { url: 'https://chatgpt.com/', slot: 'chatgpt-plan', background: true });
    const b = await c.ask('open', { url: 'https://claude.ai/projects', slot: 'claude-link', background: true });
    expect(b.tabId).toBe(60);
    expect(c.tabs.get(60).windowId).toBe(c.tabs.get(a.tabId).windowId);
    expect(c.moved).toEqual([[60, c.tabs.get(a.tabId).windowId]]);
    expect(c.created.filter(([k]) => k === 'window')).toHaveLength(1);
  });

  it('stayAwake: the page believes it is shown, and its drawing callbacks still run while hidden', async () => {
    const c = workChrome();
    await c.start();
    await c.ask('open', { url: 'https://gemini.google.com/app', slot: 'orchestrator-gemini', background: true });
    const { func } = c.injected.find((o) => o.func?.name === 'stayAwake');
    class Document {}
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Document.prototype.hasFocus = () => false;
    const document = new Document();
    document.addEventListener = () => {};
    const ran = [];
    const window = { addEventListener: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
    const ctx = { window, document, Document, setTimeout, clearTimeout, performance: { now: () => 5 }, Object };
    window.window = window;
    vm.runInNewContext(`(${func.toString()})()`, ctx);
    expect(document.hidden).toBe(false);
    expect(document.visibilityState).toBe('visible');
    expect(document.hasFocus()).toBe(true);
    window.requestAnimationFrame((t) => ran.push(t));
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).toEqual([5]);
  });
});

describe('awake.js in a page (runs first in every page)', () => {
  function page(href, stored = {}) {
    class Document {}
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
    const document = new Document();
    document.addEventListener = () => {};
    const store = { ...stored };
    const loc = { href, get hash() { return (this.href.match(/#.*/) || [''])[0]; } };
    const ctx = {
      document, Document, location: loc, setTimeout, clearTimeout, performance: { now: () => 0 }, Object,
      sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
      history: { state: null, replaceState: (_s, _t, u) => { loc.href = u; } },
    };
    ctx.window = { addEventListener: () => {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
    vm.createContext(ctx);
    vm.runInContext(read('awake.js'), ctx);
    return { document, loc, store };
  }

  it('a tab Novi marked: kept awake, the mark remembered and taken out of the address', () => {
    const p = page('https://gemini.google.com/app#novi-work');
    expect(p.document.hidden).toBe(false);
    expect(p.store.__noviWork).toBe('1');
    expect(p.loc.href).toBe('https://gemini.google.com/app');
    expect(page('https://gemini.google.com/app/123', { __noviWork: '1' }).document.hidden).toBe(false); // later pages in that tab
  });

  it('your own tabs: nothing changes', () => {
    expect(page('https://gemini.google.com/app').document.hidden).toBe(true);
  });
});

describe('popup', () => {
  it('keeps showing the live status, not a fixed "connecting…"', () => {
    const popup = read('popup.js');
    expect(popup).toMatch(/setInterval\(/);
  });
});
