import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { WA, zipForSend, createWebDriver } from '../../plugins/browser/whatsapp.js';

function fakeBridge({ chats = ['Rahul Sharma'], header = null, qr = false, ticks = true } = {}) {
  const calls = [];
  let opened = null;
  const bridge = {
    async request(cmd, args = {}) {
      calls.push([cmd, args]);
      if (cmd === 'tabs') return { tabs: [{ id: 7, url: 'https://web.whatsapp.com/', title: 'WhatsApp' }] };
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
    expect(calls).toContainEqual(['switch', { tabId: 7 }]);
    expect(calls).toContainEqual(['typeSel', { selector: WA.search, text: 'rahul' }]);
    expect(calls.find(([c]) => c === 'attach')[1]).toMatchObject({ selector: WA.fileInput, name: 'notes.zip', b64: Buffer.from('zip').toString('base64') });
    expect(calls.some(([c, a]) => c === 'clickSel' && a.selector === WA.send)).toBe(false);
    expect(await d.send()).toEqual({ sent: true });
    expect(calls).toContainEqual(['clickSel', { selector: WA.send }]);
  });

  it('nobody, or two people → no chat is opened', async () => {
    const none = createWebDriver({ bridge: fakeBridge({ chats: [] }).bridge, ...fast });
    expect(await none.prepare({ to: 'Rahul', text: 'hi' })).toEqual({ error: "I can't find Rahul on WhatsApp." });
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
    expect(calls).toContainEqual(['typeSel', { selector: WA.compose, text: "I'll be late" }]);
    expect(await d.send()).toEqual({ sent: false });
    await d.cancel();
    expect(calls).toContainEqual(['typeSel', { selector: WA.compose, text: '' }]);
  });
});
