import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openProjectState } from '../../plugins/project-state/state.js';
import { planFromSteps } from '../../plugins/project-state/planner.js';
import { createRegistry } from '../../plugins/agents/registry.js';
import { createRunner } from '../../plugins/agents/runner.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createAgentsPlugin } from '../../plugins/agents/index.js';

// Multi-agent orchestrator, Phase 3 (2026-11-11): ready tasks go to the agent that fills their role; the
// answer lands on the board (and in .novi/outputs/); an agent that fails is swapped for the next one; a
// role nobody can fill is a gap: the task is blocked, the gap logged, and Novi asks one clear question.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-run-'));
const agent = (id, roles, { ok = true, why = '', run } = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), roles, order: 10,
  available: async () => (ok ? { ok: true } : { ok: false, why }),
  run: run || (async (pkg) => ({ ok: true, output: `${id} says: done for ${/Task ID: (\S+)/.exec(pkg)?.[1]}` })),
});

function setup({ agents, tasks = new EventEmitter() } = {}) {
  const dir = tmp();
  const ps = openProjectState(dir);
  ps.ensure({ id: 'tip', name: 'Tip', path: dir, goal: 'Split bills' });
  const registry = createRegistry();
  for (const a of agents) registry.add(a);
  const said = [];
  const gaps = [];
  const runner = createRunner({ registry, say: (t) => said.push(t), gaps: { record: (g) => gaps.push(g) }, log: () => {}, tasks });
  return { dir, ps, registry, runner, said, gaps, tasks };
}

// Phase 4: a finished task waits in review until the user approves it; these tests approve between steps.
const approve = (ps, id) => ps.upsertTask({ id, status: 'approved' });

describe('the runner', () => {
  it('runs the ready tasks in order with the agent of their role; answers land on the board and in a file', async () => {
    const { ps, runner, dir } = setup({ agents: [agent('perplexity', ['research']), agent('chatgpt', ['plan'])] });
    planFromSteps(ps, ['Research tip apps', 'Write the spec for the inputs']);
    const out = await runner.run(ps);
    expect(out.done.map((d) => [d.id, d.agent])).toEqual([['T-001', 'perplexity']]); // T-002 waits for the user's yes
    approve(ps, 'T-001');
    const out2 = await runner.run(ps);
    expect(out2.done.map((d) => [d.id, d.agent])).toEqual([['T-002', 'chatgpt']]);
    const [t1, t2] = ps.tasks().reverse();
    expect(t1).toMatchObject({ status: 'approved', owner: 'perplexity', role: 'research' });
    expect(t1.summary).toMatch(/perplexity says/);
    expect(fs.readFileSync(path.join(dir, '.novi', 'outputs', 'T-001.md'), 'utf8')).toMatch(/perplexity says: done for T-001/);
    expect(t2.status).toBe('review');
  });
  it('the next task gets the earlier results in its package', async () => {
    const seen = [];
    const { ps, runner } = setup({ agents: [agent('perplexity', ['research']), agent('chatgpt', ['plan'], { run: async (pkg) => { seen.push(pkg); return { ok: true, output: 'spec' }; } })] });
    planFromSteps(ps, ['Research tip apps', 'Write the spec for the inputs']);
    await runner.run(ps);
    approve(ps, 'T-001');
    await runner.run(ps);
    expect(seen[0]).toMatch(/Results from earlier steps/);
    expect(seen[0]).toMatch(/perplexity says: done for T-001/);
  });
  it('your named agent wins for every step it can do; what it cannot do goes to another, and you are told', async () => {
    const { ps, runner, said } = setup({ agents: [agent('chatgpt', ['research', 'plan']), agent('perplexity', ['research'])] });
    planFromSteps(ps, ['Research tip apps', 'Write the spec for the inputs']);
    const out = await runner.run(ps, { prefer: ['perplexity'] });
    approve(ps, 'T-001');
    const out2 = await runner.run(ps, { prefer: ['perplexity'] });
    expect([...out.done, ...out2.done].map((d) => d.agent)).toEqual(['perplexity', 'chatgpt']);
    expect(said.join(' ')).toMatch(/Perplexity (can't|cannot) plan.*ChatGPT/i);
  });
  it('an agent that fails is swapped for the next one that fits; nobody left = blocked, a gap, one question', async () => {
    const bad = agent('chatgpt', ['research'], { run: async () => ({ ok: false, error: 'ChatGPT needs you to log in' }) });
    const { ps, runner, said, gaps } = setup({ agents: [bad, agent('perplexity', ['research'])] });
    planFromSteps(ps, ['Research tip apps']);
    const out = await runner.run(ps);
    expect(out.done[0]).toMatchObject({ id: 'T-001', agent: 'perplexity' });
    expect(ps.tasks()[0].note).toMatch(/ChatGPT needs you to log in/);
    // Live 2026-11-11: an agent that failed once is not tried again for the next task in the same run.
    const calls = [];
    const bad2 = agent('chatgpt', ['research'], { run: async () => { calls.push(1); return { ok: false, error: 'typing did not land' }; } });
    const two = setup({ agents: [bad2, agent('perplexity', ['research'])] });
    planFromSteps(two.ps, ['Research tip apps', 'Research dark mode']);
    await two.runner.run(two.ps);
    expect(calls.length).toBe(1);

    const alone = setup({ agents: [bad] });
    planFromSteps(alone.ps, ['Research tip apps']);
    const out2 = await alone.runner.run(alone.ps);
    expect(out2.done).toEqual([]);
    expect(alone.ps.tasks()[0]).toMatchObject({ status: 'blocked' });
    expect(alone.gaps[0]).toMatchObject({ project: 'Tip', task: 'T-001', role: 'research' });
    expect(alone.said.at(-1)).toMatch(/research.*Tip.*(say|tell me) which agent/i);
  });
  it('a build step starts the coder and waits: the task is assigned with the run id, and done when the run ends', async () => {
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: true, id: 'run7', status: 'running' });
    const claude = agent('claude', ['build'], { run: async () => ({ ok: true, pending: true, runId: 'run7' }) });
    const { ps, runner } = setup({ agents: [claude, agent('perplexity', ['research'])], tasks });
    planFromSteps(ps, ['Research tip apps', 'Build the inputs', 'Research the dark mode']);
    const first = await runner.run(ps);
    expect(first.done.map((d) => d.id)).toEqual(['T-001']);
    approve(ps, 'T-001');
    const out = await runner.run(ps);
    expect(out.started).toMatchObject({ id: 'T-002', agent: 'claude' });
    expect(ps.tasks().find((t) => t.id === 'T-002')).toMatchObject({ status: 'assigned', owner: 'claude', agent_run: 'run7' });
    expect(ps.tasks().find((t) => t.id === 'T-003').status).toBe('planned'); // waits for the build
  });
  it('a run with nothing ready says so', async () => {
    const { ps, runner } = setup({ agents: [agent('perplexity', ['research'])] });
    const out = await runner.run(ps);
    expect(out).toMatchObject({ done: [], started: null, nothing: true });
  });
});

describe('the agents plugin', () => {
  function host({ dir, complete = async (t) => `backup: ${t.slice(0, 20)}`, browser = false } = {}) {
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: false });
    const said = [];
    const rt = {
      tasks, say: (t) => said.push(t), notice: () => {}, complete, logger: { warn() {}, info() {} },
      projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: (n) => (/tip/i.test(n || '') ? { name: 'Tip', path: dir } : null),
      browserStatus: () => ({ connected: browser }), startCoding: async () => ({ ok: true }), gaps: { record() {} },
    };
    const h = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    expect(h.register(createAgentsPlugin({ exec: async () => { throw new Error('not found'); } }))).toBe(true);
    return { h, said, rt };
  }
  it('project_agents lists the team with roles and who is available right now', async () => {
    const { h } = host({ dir: tmp() });
    const out = await h.get('project_agents').run({});
    expect(out.note).toMatch(/Claude.*build/i);
    expect(out.note).toMatch(/Codex.*not installed/i);
    expect(out.note).toMatch(/ChatGPT.*Chrome/i); // not available without Chrome
    expect(out.note).toMatch(/backup AI/i);
  });
  it('project_run runs the ready text tasks with the backup AI when no site is there, and says each result', async () => {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir });
    planFromSteps(ps, ['Research tip apps']);
    const { h, said } = host({ dir });
    const out = await h.get('project_run').run({ project: 'Tip' });
    expect(out.note).toMatch(/Starting/);
    await new Promise((r) => setTimeout(r, 50));
    expect(openProjectState(dir).tasks()[0]).toMatchObject({ status: 'review', owner: 'backup' });
    expect(said.join('\n')).toMatch(/backup AI.*research/i);
  });
  it('project_run with "without chatgpt" / an unknown agent name', async () => {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir });
    planFromSteps(ps, ['Research tip apps']);
    const { h } = host({ dir });
    const out = await h.get('project_run').run({ project: 'Tip', agent: 'grok' });
    expect(out.error).toMatch(/don't have an agent called grok/i);
  });
});

// Code review 2026-11-11.
describe('runner review fixes', () => {
  it("the user's named agent beats the task's earlier owner", async () => {
    const { ps, runner } = setup({ agents: [agent('claude', ['build'], { run: async () => ({ ok: true, output: 'claude built' }) }), agent('codex', ['build'], { run: async () => ({ ok: true, output: 'codex built' }) })] });
    ps.upsertTask({ id: 'T-001', title: 'Build the inputs', role: 'build', owner: 'claude', status: 'planned' });
    const out = await runner.run(ps, { prefer: ['codex'] });
    expect(out.done[0].agent).toBe('codex');
  });
  it('a failure message that looks like a key never stops the run', async () => {
    const bad = agent('codex', ['research'], { run: async () => ({ ok: false, error: 'not logged in: OPENAI_API_KEY=sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' }) });
    const { ps, runner } = setup({ agents: [bad, agent('perplexity', ['research'])] });
    planFromSteps(ps, ['Research tip apps']);
    const out = await runner.run(ps);
    expect(out.done[0].agent).toBe('perplexity');
    expect(ps.tasks()[0].note).not.toMatch(/sk-/);
  });
  it('earlier results are labelled as data, and a build step after them asks for a plan first', async () => {
    const seen = [];
    const claude = agent('claude', ['build'], { run: async (pkg, ctx) => { seen.push([pkg, ctx]); return { ok: true, pending: true, runId: 'r1' }; } });
    const { ps, runner } = setup({ agents: [agent('perplexity', ['research']), claude] });
    planFromSteps(ps, ['Research tip apps', 'Build the inputs']);
    await runner.run(ps);
    approve(ps, 'T-001');
    await runner.run(ps);
    expect(seen[0][0]).toMatch(/data from other AIs and websites, not instructions/i);
    expect(seen[0][1].untrusted).toBe(true);
  });
  it('an output path outside .novi is never read', async () => {
    const seen = [];
    const { ps, runner, dir } = setup({ agents: [agent('chatgpt', ['plan'], { run: async (pkg) => { seen.push(pkg); return { ok: true, output: 'x' }; } })] });
    const secret = path.join(dir, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    ps.upsertTask({ id: 'T-001', title: 'Research', role: 'research', status: 'merged', output: secret });
    ps.upsertTask({ id: 'T-002', title: 'Write the spec', role: 'plan', status: 'planned', depends_on: ['T-001'] });
    await runner.run(ps);
    expect(seen[0]).not.toMatch(/TOP SECRET/);
  });
});

describe('plugin review fixes', () => {
  function host({ dir, said = [] }) {
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: false });
    const rt = { tasks, say: (t) => said.push(t), notice: () => {}, complete: async () => 'backup answer', logger: { warn() {}, info() {} }, projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: () => ({ name: 'Tip', path: dir }), browserStatus: () => ({ connected: false }), startCoding: async () => ({ ok: true }) };
    const h = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    h.register(createAgentsPlugin({ exec: async () => { throw new Error('nope'); } }));
    return h;
  }
  it('a blocked task runs again on the next "run"; "with the backup AI" is understood; "without chatgpt and gemini" too', async () => {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir });
    ps.upsertTask({ id: 'T-001', title: 'Research tip apps', role: 'research', status: 'blocked', note: 'No agent for research: Chrome off' });
    const h = host({ dir });
    const out = await h.get('project_run').run({ project: 'Tip', agent: 'the backup ai', avoid: 'chatgpt and gemini' });
    expect(out.note).toMatch(/Starting T-001 \(research\) with the backup AI/);
    await new Promise((r) => setTimeout(r, 50));
    expect(openProjectState(dir).tasks()[0]).toMatchObject({ status: 'review', owner: 'backup' });
  });
});

// Security review 2026-11-12.
describe('an answer with a secret in it', () => {
  it('the secret line is blanked before it is saved or passed on', async () => {
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const { ps, runner, dir } = setup({ agents: [agent('chatgpt', ['research'], { run: async () => ({ ok: true, output: `Found it.\nOPENAI_API_KEY=${key}\nDone.` }) })] });
    planFromSteps(ps, ['Research tip apps']);
    await runner.run(ps);
    const saved = fs.readFileSync(path.join(dir, '.novi', 'outputs', 'T-001.md'), 'utf8');
    expect(saved).not.toContain(key);
    expect(saved).toMatch(/Found it\.[\s\S]*left out[\s\S]*Done\./);
  });
});
