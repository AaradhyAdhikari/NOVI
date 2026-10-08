import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createBriefingPlugin, birthdaysOn } from '../../plugins/briefing/index.js';

let dataDir;
let clock;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-brief-')); clock = new Date('2026-10-07T07:30:00'); });
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const FULL = {
  weather_get: { place: 'Pune, Maharashtra, India', current: { temperature: 24.4, summary: 'clear sky' }, days: [{ summary: 'partly cloudy', min: 22.8, max: 33.1, rainChance: 10 }] },
  calendar_events: { events: [{ title: 'DBMS lecture', start: { dateTime: '2026-10-07T11:00:00+05:30' } }, { title: 'Gym', start: { dateTime: '2026-10-07T18:00:00+05:30' } }] },
  tasks_list: { tasks: [{ title: 'Submit DBMS assignment', due: '2026-10-07T00:00:00.000Z' }, { title: 'Old thing', due: '2026-10-01T00:00:00.000Z' }, { title: 'Someday' }] },
  gmail_search: { messages: [{ from: 'Prof. Rao <rao@uni.edu>', subject: 'Exam schedule' }, { from: 'GitHub <noreply@github.com>', subject: 'x' }] },
  github_notifications: { notifications: [{ repo: 'me/novi', title: 'CI failed' }] },
  reminder_list: { items: [{ text: 'call mom', when: 'today at 6:00 pm' }, { text: 'pay rent', when: 'on 10 Oct at 9:00 am' }] },
  memory_list: { facts: [{ text: "Mom's birthday is 7 October." }, { text: 'Rohan lives in Mumbai.' }] },
};

function setup(results = FULL, { failing = [] } = {}) {
  const called = [];
  const said = [];
  const sayOptions = [];
  const runtime = {
    dataDir,
    say: (t, o) => { said.push(t); sayOptions.push(o); },
    callTool: async (name, params) => {
      called.push([name, params]);
      if (failing.includes(name)) throw new Error(`${name} is down`);
      if (!(name in results)) throw new Error(`Unknown tool ${name}`);
      return { text: '', ...results[name] };
    },
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, log() {} } });
  expect(host.register(createBriefingPlugin({ now: () => clock, tickMs: 1000 }))).toBe(true);
  return { host, called, said, sayOptions, run: (n, p = {}) => host.get(n).run(p) };
}

describe('morning briefing', () => {
  it('gathers the day from the read-only tools and says a short summary', async () => {
    const { run, called } = setup();
    const out = await run('briefing_get');
    expect(called.map(([n]) => n).sort()).toEqual(['backup_status', 'calendar_events', 'github_notifications', 'gmail_search', 'memory_list', 'project_next', 'reminder_list', 'tasks_list', 'weather_get'].sort());
    expect(called.find(([n]) => n === 'gmail_search')[1].query).toMatch(/is:unread/);
    const s = out.spoken;
    expect(s).toMatch(/^Good morning/);
    expect(s).toMatch(/24 degrees and clear sky in Pune, up to 33/);
    expect(s).toMatch(/2 things on your calendar, first DBMS lecture at 11:00/);
    expect(s).toMatch(/2 tasks due, including Submit DBMS assignment/);
    expect(s).toMatch(/2 unread emails, including Prof\. Rao: Exam schedule/);
    expect(s).toMatch(/1 GitHub notification/);
    expect(s).toMatch(/Reminder today: call mom/);
    expect(s).not.toMatch(/pay rent/);
    expect(s).toMatch(/Today is Mom's birthday/);
    expect(out.text).toContain('DBMS lecture');
    expect(out.sensitive).toBe(true);
  });

  it('skips parts that are not set up or fail, and still briefs', async () => {
    const { run } = setup({ weather_get: { text: 'Which city should I check the weather for?' }, memory_list: { facts: [] } }, { failing: ['calendar_events'] });
    const out = await run('briefing_get');
    expect(out.spoken).toMatch(/^Good morning/);
    expect(out.spoken).not.toMatch(/degrees|calendar/);
    expect(out.text).toMatch(/calendar: not available/i);
  });

  it('greets by time of day', async () => {
    clock = new Date('2026-10-07T19:00:00');
    const { run } = setup({});
    expect((await run('briefing_get')).spoken).toMatch(/^Good evening/);
  });
});

describe('birthdays from memory', () => {
  it('finds birthdays today and tomorrow in either date order', () => {
    const facts = ["Mom's birthday is 7 October.", "Rohan's birthday: October 8th", 'Dad birthday 25 Dec', 'I like tea'];
    expect(birthdaysOn(facts, new Date('2026-10-07T09:00:00'))).toEqual({ today: ["Mom's"], tomorrow: ["Rohan's"] });
  });
});

describe('daily schedule', () => {
  it('can be set by voice, survives a restart, and speaks once at that time each day', async () => {
    clock = new Date('2026-10-07T07:28:00');
    const a = setup();
    expect((await a.run('briefing_schedule', { time: '7:30' })).text).toMatch(/every day at 07:30/);
    const b = setup();
    await b.host.startServices();
    clock = new Date('2026-10-07T07:30:20');
    await new Promise((r) => setTimeout(r, 1300));
    await new Promise((r) => setTimeout(r, 1300));
    await b.host.stopServices();
    expect(b.said).toHaveLength(1);
    expect(b.said[0]).toMatch(/^Good morning/);
  });

  it('turns off', async () => {
    const { run } = setup();
    await run('briefing_schedule', { time: '07:30' });
    expect((await run('briefing_schedule', { time: 'off' })).text).toMatch(/off/i);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'briefing.json'), 'utf8')).time).toBeNull();
  });

  it('rejects a time it cannot read', async () => {
    expect((await setup().run('briefing_schedule', { time: 'morningish' })).text).toMatch(/HH:MM/);
  });

  it('adds where you left off on your project, and says when the Drive backup failed', async () => {
    const { run } = setup({ ...FULL, project_next: { project: 'NOVI CONTEXT', text: 'Last time you added easy pairing. Still open: retrain the wake word.' }, backup_status: { text: '', drive: { lastError: { message: 'Google is not connected' } } } });
    const out = await run('briefing_get');
    expect(out.spoken).toMatch(/On NOVI CONTEXT: Last time you added easy pairing./);
    expect(out.spoken).toMatch(/Drive backup failed/);
    expect(out.text).toMatch(/Projects: NOVI CONTEXT — Last time you added easy pairing/);
  });

  it('a healthy backup is not mentioned', async () => {
    const { run } = setup({ ...FULL, backup_status: { text: '', drive: { lastUpload: { name: 'novi-data-x.zip' } } } });
    expect((await run('briefing_get')).spoken).not.toMatch(/backup/i);
  });

  it('the scheduled briefing is also a phone notification (kind briefing)', async () => {
    clock = new Date('2026-10-07T07:28:00');
    const { run, host, said, sayOptions } = setup();
    await run('briefing_schedule', { time: '7:30 am' });
    await host.startServices();
    clock = new Date('2026-10-07T07:30:20');
    await new Promise((r) => setTimeout(r, 1300)); // the briefing checks the clock every second here
    expect(said.length).toBe(1);
    expect(sayOptions[0]).toEqual({ kind: 'briefing' });
    await host.stopServices();
  });
});

