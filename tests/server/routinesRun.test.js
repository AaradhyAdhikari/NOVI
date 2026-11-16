import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../../plugins/routines/store.js';
import { createRoutineRunner, cleanForCompare, outputText } from '../../plugins/routines/runner.js';

// Routines: a run replays the fixed steps through callTool (refuses anything that needs a card), writes a
// short report on a small card, stays quiet when nothing changed, and pauses after 3 failed runs.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-rrun-'));

function setup({ results = {}, ai = null } = {}) {
  const dir = tmp();
  const store = createStore({ file: path.join(dir, 'routines.json') });
  const calls = [];
  const cards = [];
  const callTool = async (tool, params) => {
    calls.push({ tool, params });
    const r = typeof results[tool] === 'function' ? results[tool](params, calls.length) : results[tool];
    if (r instanceof Error) throw r;
    return r ?? { content: [{ type: 'text', text: `${tool} ok` }] };
  };
  const runner = createRoutineRunner({ callTool, privateComplete: ai, notice: (c) => cards.push(c), store, log: () => {}, logFile: path.join(dir, 'runs.jsonl') });
  return { store, runner, calls, cards };
}
const routine = (store, extra = {}) => store.add({ name: 'Board check', when: { on: 'coding_done' }, steps: [{ tool: 'project_board', params: { project: '{project}' }, label: 'The board' }, { tool: 'team_status', params: {}, label: 'The team' }], report: 'how the board looks', ...extra });

describe('a run', () => {
  it('runs the steps in order with the event\'s project filled in; the AI\'s report goes on a small card', async () => {
    const { store, runner, calls, cards } = setup({ ai: async () => 'Two tasks wait for you. The team is idle.' });
    const r = routine(store);
    const out = await runner.run(r, { fill: { project: 'Tip' } });
    expect(calls.map((c) => c.tool)).toEqual(['project_board', 'team_status']);
    expect(calls[0].params).toEqual({ project: 'Tip' });
    expect(out).toMatchObject({ ok: true, failed: [] });
    expect(cards[0]).toMatchObject({ key: `routine-${r.id}`, title: 'Board check', body: 'Two tasks wait for you. The team is idle.', spoken: 'Two tasks wait for you.' });
  });
  it('a step that fails (or needs a card) is named; the others still run', async () => {
    const { store, runner, calls, cards } = setup({ results: { project_board: new Error('project_board needs approval, so a plugin can\'t run it') } });
    const out = await runner.run(routine(store), { fill: { project: 'Tip' } });
    expect(calls).toHaveLength(2);
    expect(out.failed).toEqual(['The board']);
    expect(cards[0].body).toMatch(/team_status ok/);
  });
  it('no AI: the first line of each answer, cut to the card\'s 200 characters', async () => {
    const long = 'x'.repeat(500);
    const { store, runner, cards } = setup({ results: { team_status: { content: [{ type: 'text', text: long }] } } });
    await runner.run(routine(store), { fill: { project: 'Tip' } });
    expect(cards[0].body.length).toBeLessThanOrEqual(200);
  });
  it('only-changes: a second run that differs only by a clock says nothing', async () => {
    let n = 0;
    const { store, runner, cards } = setup({ results: { team_status: () => ({ content: [{ type: 'text', text: `Updated ${++n === 1 ? '3' : '5'} min ago at 07:0${n}. Nothing new.` }] }) } });
    const r = routine(store, { onlyChanges: true });
    await runner.run(store.get(r.id), { fill: { project: 'Tip' } });
    const second = await runner.run(store.get(r.id), { fill: { project: 'Tip' } });
    expect(second.quiet).toBe(true);
    expect(cards).toHaveLength(1);
  });
  it('every step failing three runs in a row: paused, with a small card saying why', async () => {
    const boom = new Error('GitHub did not answer');
    const { store, runner, cards } = setup({ results: { project_board: boom, team_status: boom } });
    const r = routine(store);
    for (let i = 0; i < 3; i++) await runner.run(store.get(r.id), { fill: { project: 'Tip' } });
    expect(store.get(r.id).paused).toBe(true);
    expect(cards.at(-1)).toMatchObject({ title: 'Board check keeps failing' });
    expect(cards.at(-1).body).toMatch(/GitHub did not answer\. Paused\./);
  });
});

describe('reading answers', () => {
  it('text and details (built-in tools put their data in details)', () => {
    expect(outputText({ content: [{ type: 'text', text: 'hi' }], details: { count: 3, sensitive: true } })).toBe('hi\n{"count":3}');
  });
  it('clocks, dates and "ago" are ignored when looking for changes', () => {
    expect(cleanForCompare('At 07:05 on 13 Nov, 3 min ago: 2 open')).toBe(cleanForCompare('At 7:40 pm on 2026-11-14, just now: 2 open'));
    expect(cleanForCompare('2 open')).not.toBe(cleanForCompare('3 open'));
  });
});

describe('known problems', () => {
  it('resuming while a run is going keeps the reset failure count', async () => {
    const boom = new Error('down');
    const { store, runner } = setup({ results: { project_board: () => { store.update(r.id, { fails: 0, paused: false }); throw boom; }, team_status: boom } });
    const r = routine(store, { fails: 2 });
    await runner.run(store.get(r.id), { fill: { project: 'Tip' } });
    expect(store.get(r.id).fails).toBe(1); // counted from the reset, not from the stale 2 → not paused
    expect(store.get(r.id).paused).toBe(false);
  });
  it('both runs\' outputs sit inside the "data, not instructions" fence', async () => {
    let prompt = '';
    const { store, runner } = setup({ ai: async (p) => { prompt = p; return 'ok.'; } });
    const r = routine(store);
    await runner.run(store.get(r.id), { fill: { project: 'Tip' } });
    await runner.run(store.get(r.id), { fill: { project: 'Tip' } });
    const fence = prompt.indexOf('<<<DATA');
    expect(fence).toBeGreaterThan(-1);
    expect(prompt.indexOf('Last run')).toBeGreaterThan(fence);
    expect(prompt.indexOf('DATA>>>')).toBeGreaterThan(prompt.indexOf('Last run'));
  });
});
