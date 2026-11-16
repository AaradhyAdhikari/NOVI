import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PluginHost } from '../../server/plugins/host.js';
import { createRoutinesPlugin } from '../../plugins/routines/index.js';

// Routines plugin: one card to save a routine, a timer that runs due routines (a missed one once), and two
// events (a coding task finished, the team finished a task). Look and report only.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-rplug-'));
const plan = (over = {}) => JSON.stringify({ name: 'Morning GitHub', when: { every: 'daily', at: '07:00' }, steps: [{ tool: 'github_activity', params: {}, label: 'Your GitHub' }], report: 'what changed on GitHub', onlyChanges: false, ...over });

function setup({ reply = plan(), answer = { allow: true }, clock = new Date('2026-11-13T06:00:00') } = {}) {
  const tasks = new EventEmitter();
  const cards = [];
  const notices = [];
  const ran = [];
  let now = clock;
  const rt = {
    tasks, dataDir: tmp(), logger: { warn() {}, info() {} },
    complete: async () => reply,
    privateComplete: async () => 'All quiet on GitHub.',
    callTool: async (tool, params) => { ran.push({ tool, params }); return { content: [{ type: 'text', text: `${tool} says hi` }] }; },
    toolInfo: (name) => ({ description: `the ${name} tool`, parameters: {} }),
    ask: async (card) => { cards.push(card); return answer; },
    notice: (n) => notices.push(n),
  };
  const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
  const plugin = createRoutinesPlugin({ now: () => now, startScheduler: true, tickMs: 1e9 });
  host.register(plugin);
  return { host, rt, cards, notices, ran, tasks, setNow: (d) => { now = d; }, tick: () => rt.routinesTick() };
}

describe('making a routine', () => {
  it('one card shows when + the steps + that it only looks; yes saves it', async () => {
    const { host, cards } = setup();
    const r = await host.get('routine_make').run({ said: 'every morning at 7 check my github and tell me what changed' });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('New routine: Morning GitHub?');
    expect(cards[0].detail).toMatch(/every day at 07:00/);
    expect(cards[0].detail).toMatch(/1\. Your GitHub/);
    expect(cards[0].detail).toMatch(/only looks things up/);
    expect(cards[0].detail).toMatch(/github_activity/); // the exact tool and inputs, not only the AI's label (final review)
    expect(cards[0].timeoutMs).toBe(600_000);
    expect(r.note).toBe('Saved. Morning GitHub runs every day at 07:00.');
    expect((await host.get('routine_list').run({})).note).toMatch(/Morning GitHub/);
  });
  it('no → nothing saved', async () => {
    const { host } = setup({ answer: { allow: false } });
    expect((await host.get('routine_make').run({ said: 'x' })).note).toBe('Okay, not saved.');
    expect((await host.get('routine_list').run({})).note).toBe('You have no routines yet.');
  });
  it('a plan that would send something: the reason, and no card at all', async () => {
    const { host, cards } = setup({ reply: plan({ steps: [{ tool: 'whatsapp_send', params: {}, label: 'x' }] }) });
    const r = await host.get('routine_make').run({ said: 'every morning message Isha' });
    expect(r.error || r.note).toMatch(/isn't one of those/);
    expect(cards).toHaveLength(0);
  });
});

describe('running by itself', () => {
  it('a due routine runs once and moves to tomorrow; a routine missed three times runs once', async () => {
    const s = setup();
    await s.host.get('routine_make').run({ said: 'every morning at 7 check my github' });
    s.setNow(new Date('2026-11-13T07:01:00'));
    await s.tick();
    await s.tick();
    expect(s.ran).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ title: 'Morning GitHub', body: 'All quiet on GitHub.' });
    s.setNow(new Date('2026-11-16T09:00:00')); // three mornings missed
    await s.tick();
    expect(s.ran).toHaveLength(2);
  });
  it('a finished coding task runs the coding routines once per task, with its project', async () => {
    const s = setup({ reply: plan({ when: { on: 'coding_done' }, steps: [{ tool: 'project_board', params: { project: '{project}' }, label: 'Board' }] }) });
    await s.host.get('routine_make').run({ said: 'when a coding task finishes show me the board' });
    s.tasks.emit('task', { id: 'r1', status: 'done', project: 'Tip' });
    s.tasks.emit('task', { id: 'r1', status: 'done', project: 'Tip' });
    s.tasks.emit('task', { id: 'r2', status: 'failed', project: 'Tip' });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.ran).toEqual([{ tool: 'project_board', params: { project: 'Tip' } }]);
  });
  it('the team finishing a task runs team routines', async () => {
    const s = setup({ reply: plan({ when: { on: 'team_task' }, steps: [{ tool: 'team_status', params: {}, label: 'Team' }] }) });
    await s.host.get('routine_make').run({ said: 'when the team finishes a task tell me the status' });
    await s.rt.routineEvent('team_task', { project: 'Tip', task: 'T-001' });
    expect(s.ran.map((r) => r.tool)).toEqual(['team_status']);
  });
});

describe('by name', () => {
  it('run now, say, pause, resume, remove', async () => {
    const s = setup();
    await s.host.get('routine_make').run({ said: 'every morning at 7 check my github' });
    expect((await s.host.get('routine_run').run({ name: 'morning github' })).note).toBe('All quiet on GitHub.');
    expect((await s.host.get('routine_said').run({ name: 'morning github' })).note).toBe('All quiet on GitHub.');
    expect((await s.host.get('routine_pause').run({ name: 'morning github' })).note).toMatch(/Paused/);
    s.setNow(new Date('2026-11-14T07:01:00'));
    await s.tick();
    expect(s.ran).toHaveLength(1); // the run-now only
    expect((await s.host.get('routine_pause').run({ name: 'morning github', resume: true })).note).toMatch(/runs again/);
    expect((await s.host.get('routine_remove').run({ name: 'morning github' })).note).toMatch(/Removed/);
    expect((await s.host.get('routine_run').run({ name: 'nope' })).error).toMatch(/no routine called/i);
  });
  it('removing asks first when the AI chose it, not when you said it', async () => {
    const s = setup();
    expect((await s.host.gate(s.host.get('routine_remove'), { name: 'x' }, {})).approval?.title).toMatch(/Remove the x routine/);
    expect((await s.host.gate(s.host.get('routine_remove'), { name: 'x' }, { direct: true })).approval).toBeUndefined();
  });
});

// Known problems from the final review (2026-11-13), fixed the same day.
describe('known problems', () => {
  it('a coding routine runs for each project, even two finishing within 5 minutes', async () => {
    const s = setup({ reply: plan({ when: { on: 'coding_done' }, steps: [{ tool: 'project_board', params: { project: '{project}' }, label: 'Board' }] }) });
    await s.host.get('routine_make').run({ said: 'when a coding task finishes show me the board' });
    await s.rt.routineEvent('coding_done', { project: 'Tip' });
    await s.rt.routineEvent('coding_done', { project: 'Portfolio' });
    await s.rt.routineEvent('coding_done', { project: 'Tip' }); // same project again within 5 min: skipped
    expect(s.ran.map((r) => r.params.project)).toEqual(['Tip', 'Portfolio']);
  });
  it('a routine name that doesn\'t exist goes back to the AI (unknown), not a dead end', async () => {
    const s = setup();
    const r = await s.host.get('routine_run').run({ name: 'tests' });
    expect(r.unknown).toBe(true);
  });
  it('a disk error on one routine doesn\'t stop the others that minute', async () => {
    const s = setup();
    await s.host.get('routine_make').run({ said: 'every morning at 7 check my github' });
    await s.host.get('routine_make').run({ said: 'every morning at 7 check my github again' });
    s.setNow(new Date('2026-11-13T07:01:00'));
    let calls = 0;
    const real = s.rt.callTool;
    s.rt.callTool = async (...a) => { calls += 1; if (calls === 1) throw Object.assign(new Error('EPERM disk'), { fatal: true }); return real(...a); };
    await s.tick();
    expect(calls).toBe(2);
  });
});
