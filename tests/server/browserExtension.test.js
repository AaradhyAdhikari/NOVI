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
});
