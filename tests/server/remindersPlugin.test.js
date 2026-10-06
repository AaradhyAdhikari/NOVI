import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createRemindersPlugin } from '../../plugins/reminders/index.js';

let dataDir;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 3, 14, 30, 0)); // Saturday 2:30 pm
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-rem-'));
});
afterEach(() => vi.useRealTimers());

async function boot() {
  const said = [];
  const host = new PluginHost({ logger: { warn() {} }, runtime: { dataDir, say: (t) => said.push(t) } });
  expect(host.register(createRemindersPlugin())).toBe(true);
  await host.startServices();
  return { host, said };
}

describe('reminders plugin', () => {
  it('adds a reminder, confirms the resolved time, and speaks it when due', async () => {
    const { host, said } = await boot();
    const out = await host.get('reminder_add').run({ text: 'call mom', when: 'at 6 pm' });
    expect(out.text).toBe('Okay, 6:00 pm today: call mom.');
    vi.advanceTimersByTime(3.5 * 3_600_000 - 1000);
    expect(said).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(said).toEqual(['Reminder: call mom']);
    expect((await host.get('reminder_list').run({})).items).toEqual([]);
  });

  it('says when a past time was moved to the next one', async () => {
    const { host } = await boot();
    expect((await host.get('reminder_add').run({ text: 'x', when: 'at 2' })).text).toBe('Okay, 2:00 am tomorrow: x. (That time had already passed today, so I set the next one.)');
  });

  it('explains times it cannot understand', async () => {
    const { host } = await boot();
    await expect(host.get('reminder_add').run({ text: 'x', when: 'whenever' })).rejects.toThrow(/couldn't understand the time "whenever"/);
  });

  it('sets timers', async () => {
    const { host, said } = await boot();
    expect((await host.get('timer_set').run({ minutes: 10, label: 'study' })).text).toBe('Timer set for 10 minutes: study.');
    await host.get('timer_set').run({ minutes: 1 });
    vi.advanceTimersByTime(60_000);
    expect(said).toEqual(['Timer done: 1 minute.']);
    vi.advanceTimersByTime(9 * 60_000);
    expect(said).toEqual(['Timer done: 1 minute.', 'Timer done: study.']);
  });

  it('lists upcoming reminders soonest first', async () => {
    const { host } = await boot();
    await host.get('reminder_add').run({ text: 'later', when: 'tomorrow at 9' });
    await host.get('reminder_add').run({ text: 'soon', when: 'in 10 minutes' });
    const list = await host.get('reminder_list').run({});
    expect(list.items.map((i) => [i.text, i.when])).toEqual([['soon', '2:40 pm today'], ['later', '9:00 am tomorrow']]);
    expect(list.text).toBe('You have 2 reminders: 2:40 pm today: soon; 9:00 am tomorrow: later.');
  });

  it('repeats daily reminders', async () => {
    const { host, said } = await boot();
    expect((await host.get('reminder_add').run({ text: 'drink water', when: 'tomorrow at 8', repeat: 'daily' })).text).toBe('Okay, 8:00 am tomorrow, every day: drink water.');
    vi.advanceTimersByTime(48 * 3_600_000);
    expect(said).toEqual(['Reminder: drink water', 'Reminder: drink water']);
    expect((await host.get('reminder_list').run({})).items[0].when).toBe('8:00 am tomorrow');
  });

  it('cancels one reminder by words, and needs approval to cancel all', async () => {
    const { host, said } = await boot();
    await host.get('reminder_add').run({ text: 'check the oven', when: 'in 20 minutes' });
    await host.get('reminder_add').run({ text: 'call mom', when: 'at 6 pm' });
    expect(await host.get('reminder_cancel').gate({ match: 'oven' })).toEqual({});
    expect((await host.get('reminder_cancel').run({ match: 'oven' })).text).toBe('Cancelled: check the oven.');
    vi.advanceTimersByTime(30 * 60_000);
    expect(said).toEqual([]);
    expect((await host.get('reminder_cancel').gate({ all: true })).approval).toMatchObject({ title: 'Cancel all reminders', detail: '1 reminder', tier: 'medium' });
    expect((await host.get('reminder_cancel').run({ all: true })).text).toBe('Cancelled 1 reminder.');
    await expect(host.get('reminder_cancel').run({ match: 'nothing' })).rejects.toThrow(/no reminder matching/i);
  });

  it('survives a restart and announces reminders missed while Novi was off', async () => {
    const first = await boot();
    await first.host.get('reminder_add').run({ text: 'submit form', when: 'in 10 minutes' });
    await first.host.get('reminder_add').run({ text: 'standup', when: 'tomorrow at 9' });
    await first.host.stopServices();
    vi.setSystemTime(new Date(2026, 9, 3, 15, 0, 0)); // Novi was off for 30 minutes
    const second = await boot();
    expect(second.said).toEqual(['Missed reminder: submit form (it was due 2:40 pm today).']);
    expect((await second.host.get('reminder_list').run({})).items.map((i) => i.text)).toEqual(['standup']);
  });
});

describe('plugin services', () => {
  it('starts and stops services registered by plugins; a failing start is a warning, not a crash', async () => {
    const calls = [];
    const host = new PluginHost({ logger: { warn() {} } });
    host.register({ id: 'svc', name: 'Svc', register(api) { api.registerService({ start: () => calls.push('start'), stop: () => calls.push('stop') }); } });
    host.register({ id: 'bad', name: 'Bad', register(api) { api.registerService({ start: () => { throw new Error('nope'); } }); } });
    await host.startServices();
    await host.stopServices();
    expect(calls).toEqual(['start', 'stop']);
    expect(host.warnings.some((w) => /bad.*nope/.test(w))).toBe(true);
  });
});
