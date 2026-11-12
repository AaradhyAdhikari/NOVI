import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { openProjectState } from '../../plugins/project-state/state.js';
import { planFromSteps } from '../../plugins/project-state/planner.js';
import { createRegistry } from '../../plugins/agents/registry.js';
import { createRunner } from '../../plugins/agents/runner.js';
import { createCopies, createLocks } from '../../plugins/agents/copies.js';

// Phase 5 (2026-11-12): tasks that don't depend on each other run at the same time, each coder in its own
// copy of the project; each agent takes one task at a time; Claude works in your folder one at a time;
// two steps naming the same file never run together.
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });

function setup(agents) {
  const dir = tmp('novi-par-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.novi/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  const ps = openProjectState(dir);
  ps.ensure({ id: 'p', name: 'P', path: dir, goal: 'x' });
  const registry = createRegistry();
  for (const a of agents) registry.add(a);
  const tasks = new EventEmitter();
  let active = false;
  tasks.status = () => ({ active, id: 'run1' });
  const copies = createCopies({ root: tmp('novi-par-copies-') });
  const locks = createLocks();
  const runner = createRunner({ registry, tasks, copies, locks, say() {}, log() {} });
  return { dir, ps, runner, copies, locks, setActive: (v) => { active = v; } };
}

// A coder that waits until told, and remembers where it worked and with whom it overlapped.
function coder(id, { copies = true, log }) {
  return {
    id, name: id, roles: ['build'], order: 10, copies, levels: { easy: 10, medium: 10, hard: 10 },
    available: async () => ({ ok: true }),
    async run(pkg, { task, cwd }) {
      log.push({ id, task: task.id, cwd, at: 'start' });
      await new Promise((r) => setTimeout(r, 150));
      if (cwd) fs.writeFileSync(path.join(cwd, `${task.id}.txt`), id);
      log.push({ id, task: task.id, at: 'end' });
      return { ok: true, output: `${id} did ${task.id}` };
    },
  };
}
const independent = (ps) => { for (const t of ps.tasks()) ps.upsertTask({ id: t.id, depends_on: [] }); };

describe('several coders at once', () => {
  it('two steps that don\'t depend on each other run together, each in its own copy', async () => {
    const log = [];
    const { ps, runner, dir } = setup([coder('opencode-a', { log }), coder('opencode-b', { log })]);
    planFromSteps(ps, ['Build the header', 'Build the footer']);
    independent(ps);
    const out = await runner.run(ps);
    expect(out.done.map((d) => d.id).sort()).toEqual(['T-001', 'T-002']);
    const starts = log.filter((l) => l.at === 'start');
    expect(log.slice(0, 2).every((l) => l.at === 'start')).toBe(true); // both started before either ended
    expect(starts[0].cwd).not.toBe(starts[1].cwd);
    expect(starts.every((s) => s.cwd && s.cwd !== dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'T-001.txt'))).toBe(false); // your folder untouched until your yes
    expect(ps.tasks().map((t) => t.status)).toEqual(['review', 'review']);
  });

  it('one agent takes one task at a time', async () => {
    const log = [];
    const { ps, runner } = setup([coder('opencode-a', { log })]);
    planFromSteps(ps, ['Build the header', 'Build the footer']);
    independent(ps);
    await runner.run(ps);
    expect(log.map((l) => l.at)).toEqual(['start', 'end', 'start', 'end']);
  });

  it('two steps naming the same file never run together', async () => {
    const log = [];
    const { ps, runner, locks } = setup([coder('opencode-a', { log }), coder('opencode-b', { log })]);
    planFromSteps(ps, ['Change the title in index.html', 'Add a footer to index.html']);
    independent(ps);
    const out = await runner.run(ps);
    expect(out.done.map((d) => d.id)).toEqual(['T-001']); // the second waits: T-001 holds index.html until your answer
    expect(ps.tasks().find((t) => t.id === 'T-002').status).toBe('planned');
    locks.release('T-001');
    expect((await runner.run(ps)).done.map((d) => d.id)).toEqual(['T-002']);
  });

  it('Claude works in your folder while a free coder works in a copy', async () => {
    const log = [];
    const env = setup([]);
    const claude = { id: 'claude', name: 'Claude', roles: ['build'], order: 1, levels: { hard: 1 }, available: async () => ({ ok: true }),
      async run(pkg, { task, cwd }) { log.push({ id: 'claude', task: task.id, cwd }); env.setActive(true); return { ok: true, pending: true, runId: 'run1' }; } };
    const { ps, runner, dir } = env;
    const reg = createRegistry();
    reg.add(claude);
    reg.add(coder('opencode-a', { log }));
    const r2 = createRunner({ registry: reg, tasks: { status: () => ({ active: false }) }, copies: env.copies, locks: env.locks, say() {}, log() {} });
    planFromSteps(ps, ['Refactor the login and payment flow', 'Build the footer']);
    independent(ps);
    ps.upsertTask({ id: 'T-001', level: 'hard' });
    ps.upsertTask({ id: 'T-002', level: 'easy', owner: 'opencode-a' });
    const out = await r2.run(ps);
    expect(out.started).toMatchObject({ id: 'T-001', agent: 'claude' });
    expect(log.find((l) => l.id === 'claude').cwd).toBeUndefined(); // your folder
    expect(log.find((l) => l.id === 'opencode-a' && l.cwd).cwd).not.toBe(dir);
    expect(ps.tasks().find((t) => t.id === 'T-002').status).toBe('review');
  });

  it('a project without git: coders take turns in your folder', async () => {
    const log = [];
    const dir = tmp('novi-nogit-');
    const ps = openProjectState(dir);
    ps.ensure({ id: 'p', name: 'P', path: dir, goal: 'x' });
    const reg = createRegistry();
    reg.add(coder('opencode-a', { log }));
    reg.add(coder('opencode-b', { log }));
    const runner = createRunner({ registry: reg, copies: createCopies({ root: tmp('novi-c-') }), locks: createLocks(), say() {}, log() {} });
    planFromSteps(ps, ['Build the header', 'Build the footer']);
    independent(ps);
    await runner.run(ps);
    expect(log.map((l) => l.at)).toEqual(['start', 'end', 'start', 'end']);
  });
});

describe('your yes brings it back, commits it under your name and pushes', () => {
  async function flow({ clash = false } = {}) {
    const { PluginHost } = await import('../../server/plugins/host.js');
    const { createAgentsPlugin } = await import('../../plugins/agents/index.js');
    const { team } = await import('../../plugins/agents/team.js');
    const dir = tmp('novi-yes-');
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.novi/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'start');
    const ps = openProjectState(dir);
    ps.ensure({ id: 'p', name: 'P', path: dir, goal: 'x' });
    planFromSteps(ps, ['Change the title in index.html']);
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: false });
    const commits = [];
    const cards = [];
    const said = [];
    const rt = {
      tasks, dataDir: tmp('novi-yes-data-'), say: (t) => said.push(t), notice() {}, logger: { warn() {}, info() {} },
      projects: { list: () => [{ name: 'P', path: dir }] }, codingProject: () => ({ name: 'P', path: dir }),
      ask: async (card) => { cards.push(card); return cards.length === 1 ? { allow: true } : { allow: false }; },
      commitFiles: async (c) => { commits.push(c); return { ok: true, pushed: true, note: 'Committed and pushed to GitHub under your name.' }; },
    };
    const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    host.register(createAgentsPlugin({ exec: async () => { throw new Error('none'); }, review: { runTests: async () => ({ ran: true, ok: true, summary: '3 tests passed.' }) } }));
    let runs = 0;
    team().add({
      id: 'fake', name: 'Fake', roles: ['build'], order: 0, copies: true, levels: { easy: 0, medium: 0, hard: 0 }, available: async () => ({ ok: true }),
      async run(pkg, { cwd }) {
        runs += 1;
        fs.writeFileSync(path.join(cwd, 'index.html'), `<h1>new title ${runs}</h1>\n`);
        if (clash && runs === 1) fs.writeFileSync(path.join(dir, 'index.html'), '<h1>changed by you meanwhile</h1>\n');
        return { ok: true, output: 'Files changed: index.html\nTests: passed' };
      },
    });
    await host.get('project_run').run({ project: 'P', agent: 'fake' });
    return { dir, ps, commits, cards, said, runs: () => runs };
  }

  it('the files land in your folder and are committed with the task as the message', async () => {
    const { dir, ps, commits, cards } = await flow();
    await vi.waitFor(() => expect(commits).toHaveLength(1), { timeout: 8000 });
    expect(cards[0].prompt).toMatch(/Approve to commit and push it\?/);
    expect(commits[0]).toMatchObject({ path: dir, files: ['index.html'], message: 'T-001: Change the title in index.html' });
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('<h1>new title 1</h1>\n');
    expect(ps.tasks()[0].status).toBe('merged');
  });

  it('you changed the same file meanwhile: nothing lands, the coder redoes it on top of yours', async () => {
    const { dir, ps, commits, said, runs } = await flow({ clash: true });
    await vi.waitFor(() => expect(runs()).toBe(2), { timeout: 8000 });
    expect(said.join('\n')).toMatch(/clashes with changes in index\.html/);
    expect(commits).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe('<h1>changed by you meanwhile</h1>\n');
    await vi.waitFor(() => expect(ps.tasks()[0].status).toBe('changes_requested'), { timeout: 8000 }); // second card: no
  });
});
