import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOOK_TOOLS, isLook } from '../../plugins/routines/look.js';
import { createStore } from '../../plugins/routines/store.js';
import { parseAt, nextRun, describeWhen } from '../../plugins/routines/schedule.js';

// Routines (2026-11-13, user: "start with A" + "strictly look only"): jobs from your words that only look
// things up and tell you. This file: the look list, where routines are kept, and when they run next.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-routines-'));
const at = (s) => new Date(s);

describe('the look list', () => {
  it('only reviewed look-up tools; nothing that sends, changes or runs code', () => {
    expect(isLook('weather_get')).toBe(true);
    expect(isLook('project_board')).toBe(true);
    for (const t of ['whatsapp_send', 'code_tests', 'donecheck_run', 'code_commit', 'open_website', 'screen_click', 'laptop_run']) expect(isLook(t)).toBe(false);
    // Final review: these open claude.ai in Chrome or run git (a repo's settings can run code there).
    for (const t of ['project_status', 'claude_usage', 'code_changes']) expect(isLook(t)).toBe(false);
    expect(LOOK_TOOLS).toHaveLength(23);
  });
});

describe('where routines are kept', () => {
  it('adds, names twins "(2)", keeps them across a restart, removes', () => {
    const file = path.join(tmp(), 'routines.json');
    const s = createStore({ file });
    const a = s.add({ name: 'Morning GitHub', when: { every: 'daily', at: '07:00' }, steps: [{ tool: 'github_activity', params: {}, label: 'GitHub' }] });
    expect(a.id).toBeTruthy();
    expect(a.created_at).toBeTruthy();
    expect(s.add({ name: 'Morning GitHub', when: { every: 'daily', at: '08:00' }, steps: [] }).name).toBe('Morning GitHub (2)');
    expect(createStore({ file }).list()).toHaveLength(2);
    expect(s.byName('morning github').id).toBe(a.id);
    s.remove(a.id);
    expect(createStore({ file }).list().map((r) => r.name)).toEqual(['Morning GitHub (2)']);
  });
  it('20 at most', () => {
    const s = createStore({ file: path.join(tmp(), 'r.json') });
    for (let i = 0; i < 20; i++) s.add({ name: `R${i}`, when: { every: 'daily', at: '07:00' }, steps: [] });
    expect(s.add({ name: 'one more', when: { every: 'daily', at: '07:00' }, steps: [] })).toEqual({ error: 'You have 20 routines; remove one first.' });
  });
});

describe('when a routine runs next', () => {
  it('reads a 24-hour time only', () => {
    expect(parseAt('7:00')).toEqual({ h: 7, m: 0 });
    expect(parseAt('19:05')).toEqual({ h: 19, m: 5 });
    expect(parseAt('7pm')).toBe(null);
    expect(parseAt('25:00')).toBe(null);
  });
  it('daily, weekdays, given days, every few hours (around the clock), events never', () => {
    expect(nextRun({ every: 'daily', at: '07:00' }, at('2026-11-13T08:00:00'))).toEqual(at('2026-11-14T07:00:00'));
    expect(nextRun({ every: 'daily', at: '07:00' }, at('2026-11-13T06:00:00'))).toEqual(at('2026-11-13T07:00:00'));
    expect(nextRun({ every: 'weekdays', at: '09:30' }, at('2026-11-13T10:00:00'))).toEqual(at('2026-11-16T09:30:00')); // Fri → Mon
    expect(nextRun({ every: 'weekly:mon,thu', at: '18:00' }, at('2026-11-12T17:00:00'))).toEqual(at('2026-11-12T18:00:00')); // Thu, same day
    expect(nextRun({ every: 'hourly:3' }, at('2026-11-13T23:00:00'))).toEqual(at('2026-11-14T02:00:00'));
    expect(nextRun({ on: 'coding_done' }, at('2026-11-13T08:00:00'))).toBe(null);
  });
  it('in words', () => {
    expect(describeWhen({ every: 'daily', at: '07:00' })).toBe('every day at 07:00');
    expect(describeWhen({ every: 'weekdays', at: '09:30' })).toBe('every weekday at 09:30');
    expect(describeWhen({ every: 'weekly:mon,thu', at: '18:00' })).toBe('every Mon, Thu at 18:00');
    expect(describeWhen({ every: 'hourly:3' })).toBe('every 3 hours');
    expect(describeWhen({ every: 'hourly:1' })).toBe('every hour');
    expect(describeWhen({ on: 'coding_done' })).toBe('when a coding task finishes');
    expect(describeWhen({ on: 'team_task' })).toBe('when the team finishes a task');
  });
});
