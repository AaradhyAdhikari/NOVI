import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPhoneOnly, phoneOnlyCommand } from '../../server/phoneOnly.js';
import { createNovi } from '../../server/app.js';

// User, 2026-11-07: "why is the laptop speaker always on and saying the cards came … i want everything to be
// controlled from phone so completely off the laptops things".
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-po-'));

describe('the phone-only switch', () => {
  it('off until turned on, and remembered', () => {
    const file = path.join(temp(), 'phone-only.json');
    const a = createPhoneOnly({ file });
    expect(a.isOn()).toBe(false);
    a.set(true);
    expect(createPhoneOnly({ file }).isOn()).toBe(true);
    a.set(false);
    expect(createPhoneOnly({ file }).isOn()).toBe(false);
  });
  it('hears it said', () => {
    for (const t of ['phone only', 'Novi, phone only', 'phone only mode', 'phone only on', 'laptop voice off', 'turn off laptop voice']) expect(phoneOnlyCommand(t), t).toBe(true);
    for (const t of ['phone only off', 'laptop voice on', 'turn on laptop voice', 'laptop can talk']) expect(phoneOnlyCommand(t), t).toBe(false);
    for (const t of ['call my phone', 'send this to my phone only', 'turn off the laptop', 'mute']) expect(phoneOnlyCommand(t), t).toBe(null);
  });
});

describe('with it on, the laptop stays out of it', () => {
  function start(on) {
    const dataDir = temp();
    if (on) fs.writeFileSync(path.join(dataDir, 'phone-only.json'), JSON.stringify({ on: true }));
    const spoken = [];
    const tasks = Object.assign(new EventEmitter(), { status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {} });
    const novi = createNovi({ dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand: 'claude', coder: 'free' }, {
      tasks, agent: { handle: async (t) => `echo: ${t}` }, router: { status: () => [] }, transcribe: async () => 'hello',
      lanUrls: [], cipher: { protect: async (v) => v, unprotect: async (v) => v }, localSpeaker: (t) => spoken.push(t),
    });
    const toasts = [];
    novi.plugins.runtime.laptopNotify = async (a) => toasts.push(a);
    return { novi, spoken, toasts, tasks };
  }
  const card = (s) => { s.novi.plugins.runtime.ask({ title: 'Claude wants to run a command', prompt: 'Run it?', source: 'claude' }).catch(() => {}); };

  it('off: a card is still spoken and popped up on the laptop, as before', () => {
    const s = start(false);
    card(s);
    expect(s.spoken).toHaveLength(1);
    expect(s.toasts).toHaveLength(1);
  });
  it('on: a card makes no sound and no Windows popup on the laptop', () => {
    const s = start(true);
    card(s);
    expect(s.spoken).toEqual([]);
    expect(s.toasts).toEqual([]);
  });
  it('on: the card still exists for the phone', () => {
    const s = start(true);
    card(s);
    expect(s.novi.snapshot().cards).toHaveLength(1);
  });
  it('on: nothing spoken for a reply at the laptop, and it still shows in the chat', async () => {
    const s = start(true);
    await s.novi.runVoiceCommand(Buffer.from('RIFF'));
    expect(s.spoken).toEqual([]);
    expect(s.novi.snapshot().transcript.at(-1)).toMatchObject({ role: 'novi', text: 'echo: hello' });
  });
  it("on: Claude's spoken updates go to the chat instead", () => {
    const s = start(true);
    s.tasks.emit('speak', 'Claude finished.');
    expect(s.spoken).toEqual([]);
    expect(s.novi.snapshot().transcript.at(-1)).toMatchObject({ text: 'Claude finished.' });
  });
});
