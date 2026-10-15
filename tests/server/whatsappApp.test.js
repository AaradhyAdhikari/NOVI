import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createAppDriver } from '../../plugins/browser/whatsappApp.js';

const WA_WIN = { id: 42, title: 'WhatsApp', process: 'WhatsApp.Root' };
function setup({ windows = [WA_WIN], startsWindow = true, names = ['Rahul Sharma'], header = 'Rahul Sharma', sent = 'yes' } = {}) {
  const calls = [];
  const prompts = [];
  let started = false;
  const worker = {
    async run(cmd, args = {}) {
      calls.push([cmd, args]);
      if (cmd === 'windows') return { windows: windows.length || (started && startsWindow) ? (windows.length ? windows : [WA_WIN]) : [] };
      if (cmd === 'start-whatsapp') { started = true; return {}; }
      if (cmd === 'shot-window') return { png: Buffer.from('png').toString('base64') };
      return {};
    },
  };
  const vision = async (png, prompt) => {
    prompts.push(prompt);
    if (/names/i.test(prompt)) return JSON.stringify(names);
    if (/header/i.test(prompt)) return header;
    return sent;
  };
  const d = createAppDriver({ worker, vision, sleep: async () => {} });
  return { d, calls, prompts };
}

describe('WhatsApp desktop app driver', () => {
  it('focuses WhatsApp, searches, checks the chat name, pastes the file — and sends only on send()', async () => {
    const { d, calls } = setup();
    expect(await d.prepare({ to: 'rahul', file: { file: 'C:\\t\\notes.zip', name: 'notes.zip', bytes: 3 } })).toEqual({ ok: true, name: 'Rahul Sharma' });
    const seq = calls.map(([c, a]) => (c === 'keys' ? `keys:${a.combo}` : c));
    expect(seq.slice(0, 6)).toEqual(['windows', 'window', 'keys:find', 'keys:selectall', 'clip-set', 'keys:paste']); // old search text replaced, never added to
    expect(calls).toContainEqual(['window', { id: 42, do: 'focus' }]);
    expect(calls).toContainEqual(['clip-set', { text: 'rahu' }]); // a shorter search finds "Rahul" and "Rahull" alike
    expect(calls).toContainEqual(['clip-files', { paths: ['C:\\t\\notes.zip'] }]);
    expect(calls.filter(([c, a]) => c === 'keys' && a.combo === 'enter')).toHaveLength(1); // opening the chat only
    expect(await d.send()).toEqual({ sent: true });
    expect(calls.filter(([c, a]) => c === 'keys' && a.combo === 'enter')).toHaveLength(2);
  });

  it('a text message is pasted into the box', async () => {
    const { d, calls } = setup();
    await d.prepare({ to: 'Rahul', text: "I'll be late" });
    expect(calls).toContainEqual(['clip-set', { text: "I'll be late" }]);
    expect(calls.some(([c]) => c === 'clip-files')).toBe(false);
  });

  it('nobody / two people / wrong chat → nothing pasted', async () => {
    const none = setup({ names: [] });
    expect(await none.d.prepare({ to: 'Rahul', text: 'hi' })).toEqual({ error: 'I searched the WhatsApp app for "rahu" and nobody called Rahul came up.' });
    const two = setup({ names: ['Rahul Sharma', 'Rahul K'] });
    expect(await two.d.prepare({ to: 'Rahul', text: 'hi' })).toEqual({ choose: ['Rahul Sharma', 'Rahul K'] });
    const wrong = setup({ header: 'Rahul K' });
    expect(await wrong.d.prepare({ to: 'Rahul Sharma', text: 'hi' })).toEqual({ error: 'I opened Rahul K instead of Rahul Sharma, so I stopped.' });
    for (const s of [none, two, wrong]) expect(s.calls.some(([c, a]) => c === 'clip-set' && a.text === 'hi')).toBe(false);
  });

  it('starts WhatsApp when it is closed; says so when it cannot', async () => {
    const closed = setup({ windows: [] });
    expect((await closed.d.prepare({ to: 'Rahul', text: 'hi' })).ok).toBe(true);
    expect(closed.calls).toContainEqual(['start-whatsapp', {}]);
    const missing = setup({ windows: [], startsWindow: false });
    expect(await missing.d.prepare({ to: 'Rahul', text: 'hi' })).toEqual({ error: 'Open WhatsApp first.' });
  });

  it('not confirmed after sending; cancel presses Escape', async () => {
    const { d, calls } = setup({ sent: 'no' });
    await d.prepare({ to: 'Rahul', text: 'hi' });
    expect(await d.send()).toEqual({ sent: false });
    await d.cancel();
    expect(calls.at(-1)).toEqual(['keys', { combo: 'escape' }]);
  });
});

describe('laptop-control helper: new commands for the WhatsApp app', () => {
  it('control.ps1 knows clip-files, find/enter/escape keys, shot-window and start-whatsapp', () => {
    const ps = fs.readFileSync(new URL('../../plugins/laptop-control/control.ps1', import.meta.url), 'utf8');
    for (const s of ["'clip-files'", 'find = 0x46', 'selectall = 0x41', 'enter = 0x0D', 'escape = 0x1B', "'shot-window'", "'start-whatsapp'", 'Set-Clipboard -Path']) expect(ps, s).toContain(s);
  });
});

describe('WhatsApp app: reading the search results (live 2026-10-15: "can\'t find Isha" with no clue why)', () => {
  it('names wrapped in words or code fences are still read', async () => {
    const { parseNames } = await import('../../plugins/browser/whatsappApp.js');
    expect(parseNames('Here are the chats:\n```json\n["Ishaa", "Isha Group"]\n```')).toEqual(['Ishaa', 'Isha Group']);
    expect(parseNames('[]')).toEqual([]);
    expect(parseNames('I cannot see any WhatsApp window.')).toBe(null);
  });
  it('an unreadable screenshot says so instead of "nobody found", and is logged', async () => {
    const logs = [];
    const worker = { async run(cmd) { if (cmd === 'windows') return { windows: [WA_WIN] }; if (cmd === 'shot-window') return { png: 'cG5n' }; return {}; } };
    const d = createAppDriver({ worker, vision: async () => 'Sorry, the picture is black.', sleep: async () => {}, log: (m) => logs.push(m) });
    expect(await d.prepare({ to: 'Isha', text: 'hi' })).toEqual({ error: 'I searched the WhatsApp app for "isha" but couldn\'t read the results. Is WhatsApp showing on the laptop screen?' });
    expect(logs.join('\n')).toMatch(/\[whatsapp\] app: searched "isha", vision reply not a list: Sorry, the picture is black/);
  });
});
