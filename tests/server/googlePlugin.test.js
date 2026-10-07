import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createGooglePlugin, CALENDAR_SCOPE, TASKS_SCOPE } from '../../plugins/google/index.js';

const NOW = new Date('2026-10-07T10:15:00'); // a Wednesday, local time
const ACCOUNT = { id: 'a1', label: 'me', email: 'me@gmail.com', scopes: ['openid', CALENDAR_SCOPE, TASKS_SCOPE] };

function setup({ account = ACCOUNT, events = [], tasks = [], resolve } = {}) {
  const calls = [];
  const google = {
    configured: true,
    resolve: resolve || (() => ({ account })),
    call: async (acc, url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      if (/\/events\?/.test(url)) return { items: events };
      if (/\/events$/.test(url)) return { id: 'e1', htmlLink: 'https://calendar.google.com/x' };
      if (/\/tasks\?/.test(url)) return { items: tasks };
      if (/\/tasks$/.test(url)) return { id: 't-new' };
      if (/\/tasks\/[^/?]+$/.test(url)) return { id: 'patched' };
      throw new Error(`unexpected ${url}`);
    },
  };
  const host = new PluginHost({ runtime: { google }, env: {}, logger: { warn() {} } });
  expect(host.register(createGooglePlugin({ now: () => NOW, timeZone: 'Asia/Kolkata' }))).toBe(true);
  return { host, calls, run: (n, p = {}) => host.get(n).run(p), gate: (n, p = {}) => host.get(n).gate(p) };
}

describe('calendar', () => {
  it('lists today\'s events privately, in time order', async () => {
    const { run, calls } = setup({ events: [
      { summary: 'DBMS lecture', start: { dateTime: '2026-10-07T11:00:00+05:30' }, end: { dateTime: '2026-10-07T12:00:00+05:30' }, location: 'Room 4' },
      { summary: 'Mom birthday', start: { date: '2026-10-07' }, end: { date: '2026-10-08' } },
    ] });
    const out = await run('calendar_events');
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(u.searchParams.get('singleEvents')).toBe('true');
    expect(u.searchParams.get('orderBy')).toBe('startTime');
    expect(new Date(u.searchParams.get('timeMin')).getTime()).toBe(new Date('2026-10-07T00:00:00').getTime());
    expect(new Date(u.searchParams.get('timeMax')).getTime()).toBe(new Date('2026-10-08T00:00:00').getTime());
    expect(out.text).toMatch(/11:00.*DBMS lecture.*Room 4/);
    expect(out.text).toMatch(/all day.*Mom birthday/i);
    expect(out.sensitive).toBe(true);
  });

  it('understands "tomorrow" and multi-day ranges', async () => {
    const { run, calls } = setup();
    expect((await run('calendar_events', { date: 'tomorrow', days: 3 })).text).toMatch(/nothing/i);
    const u = new URL(calls[0].url);
    expect(new Date(u.searchParams.get('timeMin')).getTime()).toBe(new Date('2026-10-08T00:00:00').getTime());
    expect(new Date(u.searchParams.get('timeMax')).getTime()).toBe(new Date('2026-10-11T00:00:00').getTime());
  });

  it('answers "am I free" from overlapping events', async () => {
    const busy = setup({ events: [{ summary: 'Standup', start: { dateTime: '2026-10-07T17:00:00+05:30' }, end: { dateTime: '2026-10-07T17:30:00+05:30' } }] });
    expect((await busy.run('calendar_free', { start: '2026-10-07T17:00', minutes: 60 })).text).toMatch(/busy.*Standup/i);
    const free = setup();
    expect((await free.run('calendar_free', { start: '2026-10-07T17:00' })).text).toMatch(/free/i);
  });

  it('adds an event after approval (grantable "calendar"), in the local time zone', async () => {
    const { run, gate, calls } = setup();
    expect((await gate('calendar_add', { title: 'Meet Rohan', start: '2026-10-09T16:00', minutes: 30 })).approval)
      .toMatchObject({ title: 'Add to calendar: Meet Rohan', tier: 'medium', category: 'calendar', grantable: true });
    const out = await run('calendar_add', { title: 'Meet Rohan', start: '2026-10-09T16:00', minutes: 30 });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { summary: 'Meet Rohan', start: { dateTime: '2026-10-09T16:00:00', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-10-09T16:30:00', timeZone: 'Asia/Kolkata' } } });
    expect(out.text).toMatch(/Added/);
  });

  it('refuses a malformed start time instead of guessing', async () => {
    const { run, calls } = setup();
    expect((await run('calendar_add', { title: 'x', start: 'friday 4pm' })).text).toMatch(/YYYY-MM-DDTHH:MM/);
    expect(calls).toEqual([]);
  });
});

describe('tasks', () => {
  const open = [{ id: 't1', title: 'Submit DBMS assignment', due: '2026-10-09T00:00:00.000Z' }, { id: 't2', title: 'Buy milk' }];

  it('lists open tasks privately', async () => {
    const { run, calls } = setup({ tasks: open });
    const out = await run('tasks_list');
    expect(calls[0].url).toMatch(/^https:\/\/tasks\.googleapis\.com\/tasks\/v1\/lists\/@default\/tasks\?/);
    expect(new URL(calls[0].url).searchParams.get('showCompleted')).toBe('false');
    expect(out.text).toMatch(/Submit DBMS assignment \(due 9 Oct\)/);
    expect(out.text).toMatch(/Buy milk/);
    expect(out.sensitive).toBe(true);
  });

  it('adds a task after approval (grantable "tasks")', async () => {
    const { run, gate, calls } = setup();
    expect((await gate('tasks_add', { title: 'Call Rohan' })).approval).toMatchObject({ title: 'Add task: Call Rohan', category: 'tasks', grantable: true });
    await run('tasks_add', { title: 'Call Rohan', due: '2026-10-10' });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { title: 'Call Rohan', due: '2026-10-10T00:00:00.000Z' } });
  });

  it('completes the task that best matches, showing it on the approval card', async () => {
    const { run, gate, calls } = setup({ tasks: open });
    expect((await gate('tasks_complete', { task: 'dbms' })).approval).toMatchObject({ title: 'Mark task done', detail: 'Submit DBMS assignment' });
    const out = await run('tasks_complete', { task: 'dbms' });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'completed' } });
    expect(calls.at(-1).url).toMatch(/\/tasks\/t1$/);
    expect(out.text).toMatch(/Done: Submit DBMS assignment/);
  });
});

describe('accounts and permissions', () => {
  it('asks which Google account when there are several and none is default', async () => {
    const { run } = setup({ resolve: () => ({ ask: [{ label: 'me', email: 'me@gmail.com' }, { label: 'college', email: 'c@uni.edu' }] }) });
    expect((await run('calendar_events')).text).toMatch(/Which account: me \(me@gmail.com\) or college/);
  });

  it('explains how to allow Calendar/Tasks when the account was connected before', async () => {
    const { run, calls } = setup({ account: { ...ACCOUNT, scopes: ['openid', 'https://www.googleapis.com/auth/gmail.readonly'] } });
    expect((await run('calendar_events')).text).toMatch(/Connect Gmail.*again/i);
    expect((await run('tasks_list')).text).toMatch(/Connect Gmail.*again/i);
    expect(calls).toEqual([]);
  });

  it('tells the model today\'s date and time zone', async () => {
    const { host } = setup();
    const ctx = await host.promptContext({ prompt: 'what is on tomorrow', messages: [] });
    expect(ctx.context).toMatch(/Wednesday, 7 October 2026/);
    expect(ctx.context).toMatch(/Asia\/Kolkata/);
  });
});
