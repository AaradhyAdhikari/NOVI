import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const read = (f) => fs.readFileSync(new URL(`../../extension/${f}`, import.meta.url), 'utf8');

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
    for (const f of ['background.js', 'page.js', 'popup.js']) {
      expect(() => execFileSync(process.execPath, ['--check', new URL(`../../extension/${f}`, import.meta.url).pathname]), f).not.toThrow();
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
    expect(JSON.parse(read('manifest.json')).version).toBe('1.3.0');
  });
  // claude.ai's project list (2026-10-18): each card's name is its first line, its link the href.
  it('query: first line only and an attribute when asked; plain query as before', () => {
    const a = el('FlexR\nA fitness app\nUpdated 2 days ago');
    a.attrs.href = '/project/0193-a';
    const novi = fakePage([a]);
    expect(novi.query({ selector: 'a', firstLine: true, attr: 'href' })).toEqual({ texts: ['FlexR'], values: ['/project/0193-a'] });
    expect(novi.query({ selector: 'a' })).toEqual({ texts: ['FlexR A fitness app Updated 2 days ago'] });
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
      runtime: { getManifest: () => ({ version: '1.0.0' }), onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener: (f) => listeners.message.push(f) }, reload() {} },
      storage: {
        local: { get: async () => ({ ...store }), set: async (o) => { Object.assign(store, o); for (const f of listeners.changed) f(); } },
        onChanged: { addListener: (f) => listeners.changed.push(f) },
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      tabs: {}, scripting: {},
    };
    vm.runInNewContext(read('background.js'), { chrome, WebSocket: FakeSocket, setTimeout, clearTimeout, console, JSON, Promise, Error, String });
    const status = () => { let s; listeners.message[0]('status', null, (r) => { s = r.status; }); return s; };
    return { sockets, status, store, chrome };
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

describe('popup', () => {
  it('keeps showing the live status, not a fixed "connecting…"', () => {
    const popup = read('popup.js');
    expect(popup).toMatch(/setInterval\(/);
  });
});
