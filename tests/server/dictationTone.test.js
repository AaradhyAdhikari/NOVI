import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toneFor, toneLine } from '../../plugins/rewrite/tone.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createRewritePlugin } from '../../plugins/rewrite/index.js';
import { createOrbPlugin } from '../../plugins/orb/index.js';

// Checklist row "Per-app tone": casual in chat apps, formal in email, code-aware in the editor.
describe('which tone an app gets', () => {
  it('chat apps, on their own or in a browser', () => {
    for (const t of ['WhatsApp', '(3) WhatsApp - Google Chrome', 'WhatsApp Web - Brave', '#general | Friends - Discord', 'Telegram', 'Chat | Isha | Microsoft Teams', 'general (Channel) - Team - Slack']) expect(toneFor(t), t).toBe('chat');
  });
  it('email', () => {
    for (const t of ['Inbox (20) - me@gmail.com - Gmail - Google Chrome', 'Inbox - me@x.com - Outlook', 'Mail', 'Compose Mail - me@gmail.com - Gmail - Microsoft Edge']) expect(toneFor(t), t).toBe('email');
  });
  it('code editors and terminals', () => {
    for (const t of ['app.js - NOVI - Visual Studio Code', 'index.ts - Cursor', 'Windows PowerShell', 'Command Prompt', 'Main.kt - Android Studio', 'notes.txt - Notepad++']) expect(toneFor(t), t).toBe('code');
  });
  it('a page only mentioning an app is not that app', () => {
    for (const t of ['How to use WhatsApp - YouTube - Google Chrome', 'Gmail tips and tricks - Google Search - Google Chrome', 'cursor styles - MDN - Brave']) expect(toneFor(t), t).toBe(null);
  });
  it('anything else keeps the plain polish', () => {
    for (const t of ['Untitled - Notepad', 'NOVI — Personal AI Companion - Google Chrome', '', null]) expect(toneFor(t)).toBe(null);
  });
  it('each tone has its own instruction; no tone adds nothing', () => {
    expect(toneLine('chat')).toMatch(/casual/i);
    expect(toneLine('email')).toMatch(/polite|professional/i);
    expect(toneLine('code')).toMatch(/exact/i);
    expect(toneLine(null)).toBe('');
    expect(toneLine('anything')).toBe('');
  });
});

describe('the model gets the tone', () => {
  const rewrite = async (args) => {
    const seen = [];
    const host = new PluginHost({ runtime: {}, logger: { warn() {}, info() {} } });
    expect(host.register(createRewritePlugin({ llama: { ask: async (system, text) => { seen.push(system); return text; }, warm: async () => {}, stop() {} } }))).toBe(true);
    await host.get('text_rewrite').run(args);
    return seen[0];
  };
  it('a tone joins the instruction', async () => {
    expect(await rewrite({ text: 'see you at five', tone: 'chat' })).toMatch(/casual/i);
  });
  it('no tone: the plain polish as before', async () => {
    expect(await rewrite({ text: 'see you at five' })).not.toMatch(/casual/i);
  });
});

describe('hold-to-talk uses the app in front', () => {
  function make({ saved, title = 'WhatsApp', titleFails = false } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-'));
    if (saved) fs.writeFileSync(path.join(dataDir, 'dictation.json'), JSON.stringify(saved));
    const did = [];
    let fire = null;
    let titles = 0;
    const runtime = {
      dataDir, wake: { hold() {}, release: () => Buffer.from('wav') }, hear: async () => 'see you at five',
      activeWindowTitle: async () => { titles += 1; if (titleFails) throw new Error('no window'); return title; },
      callTool: async (name, p) => { did.push([name, p]); return name === 'text_rewrite' ? (p.warm ? {} : { text: `AI: ${p.text}` }) : {}; },
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    let clock = 0;
    host.register(createOrbPlugin({ platform: 'win32', env: {}, now: () => (clock += 1000), createProcess: (o) => { fire = o.onEvent; return { start() {}, stop() {}, send() {} }; } }));
    const talk = async () => {
      await host.startServices();
      await fire({ event: 'hold_start' });
      await fire({ event: 'hold_end' });
    };
    return { did, host, talk, titles: () => titles };
  }
  const typed = (s) => s.did.find(([n]) => n === 'dictate_type')?.[1].text;
  const asked = (s) => s.did.find(([n, p]) => n === 'text_rewrite' && !p.warm)?.[1];

  it('off by default: no window read, no model', async () => {
    const s = make();
    await s.talk();
    expect(s.titles()).toBe(0);
    expect(s.did).toEqual([['dictate_type', { text: 'See you at five' }]]);
  });
  it('the Settings tick is saved', async () => {
    const s = make();
    expect(await s.host.route('dictation-cleanup')({ tone: true })).toMatchObject({ tone: true });
    expect(await s.host.route('dictation-cleanup')({})).toMatchObject({ tone: true });
  });
  it('on: the tone of the app in front, even with polish off; only the kind of app is passed on', async () => {
    const s = make({ saved: { tone: true }, title: 'Inbox - me@gmail.com - Gmail - Google Chrome' });
    await s.talk();
    expect(asked(s)).toEqual({ text: 'See you at five', tone: 'email' });
    expect(typed(s)).toBe('AI: See you at five');
  });
  it('the model loads while you talk', async () => {
    const s = make({ saved: { tone: true } });
    await s.talk();
    expect(s.did[0]).toEqual(['text_rewrite', { warm: true }]);
  });
  it('an app with no tone and polish off: your words as they are', async () => {
    const s = make({ saved: { tone: true }, title: 'Untitled - Notepad' });
    await s.talk();
    expect(asked(s)).toBe(undefined);
    expect(typed(s)).toBe('See you at five');
  });
  it('an app with no tone and polish on: the plain polish', async () => {
    const s = make({ saved: { tone: true, polish: true }, title: 'Untitled - Notepad' });
    await s.talk();
    expect(asked(s)).toEqual({ text: 'See you at five' });
  });
  it('the window can not be read: dictation still types', async () => {
    const s = make({ saved: { tone: true }, titleFails: true });
    await s.talk();
    expect(typed(s)).toBe('See you at five');
  });
});
