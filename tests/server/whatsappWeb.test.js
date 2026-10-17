import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { WA, zipForSend, createWebDriver } from '../../plugins/browser/whatsapp.js';

function fakeBridge({ chats = ['Rahul Sharma'], header = null, qr = false, ticks = true, tab = true, backgroundTyping = true } = {}) {
  const calls = [];
  let opened = null;
  let typed = '';
  let front = false;
  const bridge = {
    async request(cmd, args = {}) {
      calls.push([cmd, args]);
      if (cmd === 'tabs') return { tabs: tab ? [{ id: 7, url: 'https://web.whatsapp.com/', title: 'WhatsApp' }] : [] };
      if (cmd === 'open') return { tabId: 9 };
      if (cmd === 'switch') front = true;
      if (cmd === 'typeSel' && args.selector === WA.compose && (backgroundTyping || front)) typed = args.text;
      if (cmd === 'query' && args.selector === WA.compose) return { texts: [typed] };
      if (cmd === 'waitFor') return { found: args.selector === WA.qr ? qr : !qr };
      if (cmd === 'query' && args.selector === WA.qr) return { texts: qr ? ['qr'] : [] };
      if (cmd === 'query' && args.selector === WA.chatTitles) return { texts: chats };
      if (cmd === 'query' && args.selector === WA.header) return { texts: [header ?? opened ?? ''] };
      if (cmd === 'query' && args.selector === WA.sentTick) return { texts: ticks ? ['✓'] : [] };
      if (cmd === 'clickSel' && args.selector === WA.chatTitles) opened = args.text;
      return {};
    },
  };
  return { bridge, calls };
}
const fast = { sleep: async () => {}, sendWaitMs: 50 };

describe('zipForSend', () => {
  it('a folder becomes a zip with its files; a big folder is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-wa-'));
    const folder = path.join(dir, 'DBMS notes');
    fs.mkdirSync(path.join(folder, 'unit 1'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(folder, 'unit 1', 'b.txt'), 'world');
    const out = zipForSend(folder, { tmpDir: dir });
    expect(out.name).toBe('DBMS notes.zip');
    expect(out.bytes).toBeGreaterThan(0);
    expect(new AdmZip(out.file).getEntries().map((e) => e.entryName).sort()).toEqual(['a.txt', 'unit 1/b.txt']);
    expect(() => zipForSend(folder, { tmpDir: dir, maxBytes: 3 })).toThrow('That folder is too big to send (over 100 MB).');
    const file = path.join(dir, 'resume.pdf');
    fs.writeFileSync(file, 'pdf');
    expect(zipForSend(file, { tmpDir: dir })).toMatchObject({ file, name: 'resume.pdf', bytes: 3 });
  });
});

describe('WhatsApp Web driver', () => {
  it('finds the one chat, checks its name, attaches the file and waits for the tick', async () => {
    const { bridge, calls } = fakeBridge();
    const d = createWebDriver({ bridge, ...fast });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-wa-'));
    const file = path.join(dir, 'notes.zip');
    fs.writeFileSync(file, 'zip');
    expect(await d.prepare({ to: 'rahul', file: { file, name: 'notes.zip', bytes: 3 } })).toEqual({ ok: true, name: 'Rahul Sharma' });
    expect(calls.some(([c]) => c === 'switch')).toBe(false); // the WhatsApp tab stays in the background
    expect(calls).toContainEqual(['typeSel', { selector: WA.search, text: 'rahu', tabId: 7 }]);
    expect(calls.find(([c]) => c === 'attach')[1]).toMatchObject({ selector: WA.fileInput, name: 'notes.zip', b64: Buffer.from('zip').toString('base64') });
    expect(calls.some(([c, a]) => c === 'clickSel' && a.selector === WA.send)).toBe(false);
    expect(await d.send()).toEqual({ sent: true });
    expect(calls).toContainEqual(['clickSel', { selector: WA.send, tabId: 7 }]);
  });

  it('no WhatsApp tab yet → opens one in the background; typing that did not land is retried in front', async () => {
    const none = fakeBridge({ tab: false });
    await createWebDriver({ bridge: none.bridge, ...fast }).prepare({ to: 'rahul', text: 'hi' });
    expect(none.calls).toContainEqual(['open', { url: 'https://web.whatsapp.com/', newTab: true, background: true }]);
    expect(none.calls.find(([c, a]) => c === 'waitFor' && a.selector === WA.ready)[1].tabId).toBe(9);
    const stuck = fakeBridge({ backgroundTyping: false });
    expect(await createWebDriver({ bridge: stuck.bridge, ...fast }).prepare({ to: 'rahul', text: 'hi' })).toEqual({ ok: true, name: 'Rahul Sharma' });
    expect(stuck.calls).toContainEqual(['switch', { tabId: 7 }]);
  });

  it('nobody, or two people → no chat is opened', async () => {
    const none = createWebDriver({ bridge: fakeBridge({ chats: [] }).bridge, ...fast });
    expect(await none.prepare({ to: 'Rahul', text: 'hi' })).toEqual({ error: 'I searched WhatsApp Web for "rahu" and nobody called Rahul came up.' });
    const two = fakeBridge({ chats: ['Rahul Sharma', 'Rahul K', 'Mom'] });
    expect(await createWebDriver({ bridge: two.bridge, ...fast }).prepare({ to: 'Rahul', text: 'hi' })).toEqual({ choose: ['Rahul Sharma', 'Rahul K'] });
    expect(two.calls.some(([c, a]) => c === 'clickSel' && a.selector === WA.chatTitles)).toBe(false);
  });

  it('exact name wins over similar ones', async () => {
    const { bridge } = fakeBridge({ chats: ['Rahul', 'Rahul Sharma'] });
    expect(await createWebDriver({ bridge, ...fast }).prepare({ to: 'rahul', text: 'hi' })).toEqual({ ok: true, name: 'Rahul' });
  });

  it('the opened chat must be the right person', async () => {
    const { bridge, calls } = fakeBridge({ header: 'Rahul K' });
    expect(await createWebDriver({ bridge, ...fast }).prepare({ to: 'Rahul Sharma', text: 'hi' })).toEqual({ error: 'I opened Rahul K instead of Rahul Sharma, so I stopped.' });
    expect(calls.some(([c]) => c === 'attach' || (c === 'typeSel' && calls.find(() => false)))).toBe(false);
  });

  it('not logged in → asks to scan the QR code', async () => {
    const { bridge } = fakeBridge({ qr: true });
    expect(await createWebDriver({ bridge, ...fast }).prepare({ to: 'Rahul', text: 'hi' })).toEqual({ pause: 'qr', note: 'Scan the QR code in WhatsApp on your phone, then say done.' });
  });

  it('no tick → not confirmed; cancel clears the draft', async () => {
    const { bridge, calls } = fakeBridge({ ticks: false });
    const d = createWebDriver({ bridge, ...fast });
    await d.prepare({ to: 'Rahul', text: "I'll be late" });
    expect(calls).toContainEqual(['typeSel', { selector: WA.compose, text: "I'll be late", tabId: 7 }]);
    expect(await d.send()).toEqual({ sent: false });
    await d.cancel();
    expect(calls).toContainEqual(['typeSel', { selector: WA.compose, text: '', tabId: 7 }]);
  });
});

describe('names as heard (live 2026-10-15: "Isha" vs the contact "Ishaa")', () => {
  it('one letter more or less still finds the person; a real tie still asks', async () => {
    const { pickContact, searchWord } = await import('../../plugins/browser/whatsapp.js');
    expect(pickContact(['Ishaa'], 'Isha')).toEqual({ name: 'Ishaa' });
    expect(pickContact(['Isha'], 'Ishaa')).toEqual({ name: 'Isha' });
    expect(pickContact(['Ishaa Sharma', 'Rahul'], 'isha sharma')).toEqual({ name: 'Ishaa Sharma' });
    expect(pickContact(['Isha', 'Ishaa'], 'Isha')).toEqual({ name: 'Isha' });
    expect(pickContact(['Ishan', 'Mom'], 'Ishaa')).toEqual({ none: true });
    expect(searchWord('Ishaa Sharma')).toBe('isha');
    expect(searchWord('Mom')).toBe('mom');
  });
});
