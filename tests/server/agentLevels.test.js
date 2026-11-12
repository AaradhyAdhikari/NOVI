import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { levelFor } from '../../plugins/agents/roles.js';
import { createRegistry } from '../../plugins/agents/registry.js';
import { createRecord } from '../../plugins/agents/record.js';
import { openProjectState } from '../../plugins/project-state/state.js';
import { planFromSteps } from '../../plugins/project-state/planner.js';
import { opencodeAdapter, opencodeConfig } from '../../plugins/agents/opencode.js';

// The team setup (2026-11-12, user: "the easy work is given to it and the hard is done by claude and others
// according to the benchmark"): every build step has a difficulty; each coder says which it takes and how
// early; Novi's own track record (your approvals) moves coders up or down; free models ask once per project.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-levels-'));

describe('how hard a build step is', () => {
  it('easy, medium, hard', () => {
    expect(levelFor('Change the button text to Save')).toBe('easy');
    expect(levelFor('Fix the typo in the footer')).toBe('easy');
    expect(levelFor('Make the header blue')).toBe('easy');
    expect(levelFor('Add a dark mode toggle')).toBe('medium');
    expect(levelFor('Add login with Google and store users in the database')).toBe('hard');
    expect(levelFor('Refactor the payment flow across the app')).toBe('hard');
  });
  it('the planner writes it on build steps only', () => {
    const ps = openProjectState(tmp());
    const out = planFromSteps(ps, ['Research tip apps', 'Fix the typo in the footer', 'Add login with Google']);
    expect(out.added.map((t) => [t.role, t.level ?? null])).toEqual([['research', null], ['build', 'easy'], ['build', 'hard']]);
  });
});

describe('the right coder for the difficulty', () => {
  const coder = (id, levels, extra = {}) => ({ id, name: id, roles: ['build'], levels, order: 10, available: async () => ({ ok: true }), run: async () => ({ ok: true }), ...extra });
  function team(record) {
    const r = createRegistry({ record });
    r.add(coder('claude', { easy: 90, medium: 20, hard: 10 }));
    r.add(coder('opencode-deepseek', { easy: 10, medium: 40 }));
    r.add(coder('novi-coder', { easy: 30 }));
    return r;
  }
  it('easy goes to a free coder first, hard only to Claude, medium to Claude first', async () => {
    const r = team();
    expect((await r.pick('build', { level: 'easy' })).agent.id).toBe('opencode-deepseek');
    expect((await r.pick('build', { level: 'hard' })).agent.id).toBe('claude');
    expect((await r.pick('build', { level: 'medium' })).agent.id).toBe('claude');
  });
  it('your named coder still wins, even for a level it would not get', async () => {
    expect((await team().pick('build', { level: 'hard', prefer: ['opencode-deepseek'] })).agent.id).toBe('opencode-deepseek');
  });
  it('the track record moves coders: a free coder that keeps passing medium goes ahead of Claude; one that keeps failing easy drops back', async () => {
    const file = path.join(tmp(), 'record.json');
    const rec = createRecord({ file });
    for (let i = 0; i < 6; i++) rec.note('opencode-deepseek', 'medium', 'pass');
    expect((await team(rec).pick('build', { level: 'medium' })).agent.id).toBe('opencode-deepseek');
    for (let i = 0; i < 4; i++) rec.note('opencode-deepseek', 'easy', 'back');
    expect((await team(rec).pick('build', { level: 'easy' })).agent.id).toBe('novi-coder');
    expect(createRecord({ file }).stats('opencode-deepseek', 'medium')).toMatchObject({ pass: 6, tries: 6 });
  });
  it('a step with no level (older boards) is medium', async () => {
    expect((await team().pick('build', {})).agent.id).toBe('claude');
  });
});

describe('OpenCode as a team member', () => {
  it('runs hidden on its free model with the task as a file, edits allowed, only test commands, no web, no extra tool servers', async () => {
    const calls = [];
    const dir = tmp();
    const ps = openProjectState(dir);
    const a = opencodeAdapter({ id: 'opencode-deepseek', name: 'OpenCode (DeepSeek)', model: 'opencode/deepseek-v4.1-flash-free', levels: { easy: 10 } }, {
      exec: async (args, opts) => { calls.push({ args, opts }); return '{"type":"text","part":{"text":"Done.\\n\\nFiles changed:\\n- a.js"}}\n'; },
      consent: async () => true,
    });
    const out = await a.run('PROJECT CONTEXT\n- task', { ps, project: 'Tip', task: { id: 'T-1' } });
    expect(out).toMatchObject({ ok: true });
    expect(out.output).toMatch(/Files changed/);
    const { args, opts } = calls[0];
    expect(args.slice(0, 6)).toEqual(['opencode', 'run', '--pure', '-m', 'opencode/deepseek-v4.1-flash-free', '--format']);
    expect(args.at(-2)).toBe('-f'); // the file last: -f takes everything after it as files (live 2026-11-12)
    expect(args.at(-1)).toMatch(/T-1.task.md$/);
    expect(opts.cwd).toBe(dir);
    const cfg = JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.permission.edit).toBe('allow');
    expect(cfg.permission.webfetch).toBe('deny');
    expect(cfg.permission.bash['*']).toBe('deny');
    expect(opts.env.GROQ_API_KEYS).toBeUndefined();
  });
  it('the OpenRouter key goes only to an OpenRouter model', () => {
    expect(opencodeConfig({ model: 'opencode/x', env: { OPENROUTER_API_KEYS: 'k1,k2' } }).env.OPENROUTER_API_KEY).toBeUndefined();
    expect(opencodeConfig({ model: 'openrouter/y', env: { OPENROUTER_API_KEYS: 'k1,k2' } }).env.OPENROUTER_API_KEY).toBe('k1');
  });
  it('every tool server in your own OpenCode settings is switched off for Novi\'s runs', () => {
    const cfg = JSON.parse(opencodeConfig({ model: 'opencode/x', env: {}, userMcp: ['rea', 'other'] }).env.OPENCODE_CONFIG_CONTENT);
    expect(cfg.mcp.rea.enabled).toBe(false);
    expect(cfg.mcp.other.enabled).toBe(false);
  });
  it('free models only on a project you said yes to; a no keeps them away from it', async () => {
    let asked = 0;
    const answers = { Tip: true, Bank: false };
    const a = opencodeAdapter({ id: 'opencode-deepseek', name: 'OpenCode (DeepSeek)', model: 'opencode/x', levels: { easy: 10 } }, {
      exec: async () => '1.19.5', consent: async (project) => { asked += 1; return answers[project]; },
    });
    expect((await a.available({ project: 'Tip' })).ok).toBe(true);
    expect(await a.available({ project: 'Bank' })).toMatchObject({ ok: false, why: expect.stringMatching(/free models.*Bank/i) });
    expect(asked).toBe(2);
  });
  it('OpenCode not installed: not available, said plainly', async () => {
    const a = opencodeAdapter({ id: 'opencode-x', name: 'OpenCode', model: 'opencode/x', levels: { easy: 10 } }, { exec: async () => { throw new Error('not found'); }, consent: async () => true });
    expect(await a.available({ project: 'Tip' })).toMatchObject({ ok: false, why: 'OpenCode is not installed' });
  });
});

// Live 2026-11-12: "Team test" (a space) split the task file's path; a failed coder was tried 3 times.
describe('team setup live fixes', () => {
  it('arguments with spaces stay whole on Windows; colour codes are dropped from errors', async () => {
    const { shellArgs, plainError } = await import('../../plugins/agents/adapters.js');
    expect(shellArgs(['opencode', '-f', 'C:\dev\Team test\a.md', 'Do the task'], true)).toEqual(['opencode', '-f', '"C:\dev\Team test\a.md"', '"Do the task"']);
    expect(shellArgs(['git', 'status'], true)).toEqual(['git', 'status']);
    expect(plainError('\u001b[91m\u001b[1mError: \u001b[0mFile not found')).toBe('Error: File not found');
  });
  it('a coder with a dash in its id that failed is not picked again', async () => {
    const r = createRegistry();
    r.add({ id: 'opencode-deepseek', name: 'OpenCode (DeepSeek)', roles: ['build'], levels: { easy: 10 }, available: async () => ({ ok: true }), run: async () => ({}) });
    r.add({ id: 'novi-coder', name: 'Novi Coder', roles: ['build'], levels: { easy: 30 }, available: async () => ({ ok: true }), run: async () => ({}) });
    expect((await r.pick('build', { level: 'easy', avoid: ['opencode-deepseek'] })).agent.id).toBe('novi-coder');
  });
});
describe('names with a dash', () => {
  it('a coder is found by its own id, dash and all', () => {
    const r = createRegistry();
    r.add({ id: 'opencode-pickle', name: 'OpenCode (Big Pickle)', roles: ['build'], levels: { easy: 20 }, run: async () => ({}) });
    expect(r.find('opencode-pickle')?.id).toBe('opencode-pickle');
  });
});
