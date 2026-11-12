import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { projectBoardCommand } from '../../server/brain/projectBoardCommand.js';
import { openProjectState } from '../../plugins/project-state/state.js';
import { planFromSteps } from '../../plugins/project-state/planner.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createAgentsPlugin } from '../../plugins/agents/index.js';
import { createCommitPlugin } from '../../plugins/commit/index.js';
import { team } from '../../plugins/agents/team.js';

// Orchestrator Phase 6 (2026-11-12): the team by voice. Stop it, hear what one agent said, hear who is
// doing what, and undo the last task that went to GitHub (a revert under your name, pushed).
const tmp = (p = 'novi-voice-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

describe('the words', () => {
  it('stop the team', () => {
    expect(projectBoardCommand('stop the team on tip')).toEqual({ tool: 'project_stop', args: { project: 'tip' } });
    expect(projectBoardCommand('stop the tip tasks')).toEqual({ tool: 'project_stop', args: { project: 'tip' } });
    expect(projectBoardCommand('stop all agents')).toEqual({ tool: 'project_stop', args: {} });
    expect(projectBoardCommand('stop the team')).toEqual({ tool: 'project_stop', args: {} });
  });
  it('what did an agent say', () => {
    expect(projectBoardCommand('what did chatgpt say on tip')).toEqual({ tool: 'project_said', args: { agent: 'chatgpt', project: 'tip' } });
    expect(projectBoardCommand('what did perplexity say')).toEqual({ tool: 'project_said', args: { agent: 'perplexity' } });
    expect(projectBoardCommand("what was deepseek's answer about tip")).toEqual({ tool: 'project_said', args: { agent: 'deepseek', project: 'tip' } });
  });
  it('what the team is doing', () => {
    for (const s of ["what's the team doing", 'team status', 'who is working on what', 'what are the agents doing']) expect(projectBoardCommand(s)).toEqual({ tool: 'team_status', args: {} });
  });
  it('undo the last task', () => {
    expect(projectBoardCommand('undo the last task on tip')).toEqual({ tool: 'project_undo', args: { project: 'tip' } });
    expect(projectBoardCommand('revert the last task on tip')).toEqual({ tool: 'project_undo', args: { project: 'tip' } });
    expect(projectBoardCommand('undo the last merge on tip')).toEqual({ tool: 'project_undo', args: { project: 'tip' } });
    expect(projectBoardCommand('undo that')).toBe(null);
  });
});

function host({ dir, rtExtra = {}, commit = false } = {}) {
  const tasks = new EventEmitter();
  tasks.status = () => ({ active: false });
  const said = [];
  const rt = {
    tasks, dataDir: tmp('novi-voice-data-'), say: (t) => said.push(t), notice() {}, logger: { warn() {}, info() {} },
    projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: () => ({ name: 'Tip', path: dir }),
    ask: async () => ({ allow: false }), ...rtExtra,
  };
  const h = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
  if (commit) h.register(createCommitPlugin({ run: async () => ({ code: 0 }) }));
  h.register(createAgentsPlugin({ exec: async () => { throw new Error('none'); } }));
  return { h, rt, said };
}

function board() {
  const dir = tmp('novi-voice-proj-');
  const ps = openProjectState(dir);
  ps.ensure({ id: 'tip', name: 'Tip', path: dir, goal: 'x' });
  return { dir, ps };
}

describe('what an agent said', () => {
  it('reads the newest answer of that agent, not the header', async () => {
    const { dir, ps } = board();
    planFromSteps(ps, ['Research tip apps', 'Write the spec']);
    const out = path.join(ps.dir, 'outputs');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'T-001.md'), '# T-001: Research tip apps\n\nRole: research · Agent: ChatGPT · 2026\n\nOld answer.\n');
    fs.writeFileSync(path.join(out, 'T-002.md'), '# T-002: Write the spec\n\nRole: plan · Agent: ChatGPT · 2026\n\nThe spec has three screens. Then more.\n');
    ps.upsertTask({ id: 'T-001', owner: 'chatgpt', status: 'review', output: path.join(out, 'T-001.md') });
    ps.upsertTask({ id: 'T-002', owner: 'chatgpt', status: 'review', output: path.join(out, 'T-002.md') });
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(out, 'T-002.md'), t, t);
    const { h } = host({ dir });
    const r = await h.get('project_said').run({ agent: 'chatgpt', project: 'tip' });
    expect(r.note).toMatch(/T-002/);
    expect(r.note).toMatch(/three screens/);
    expect(r.note).not.toMatch(/Role:/);
  });
  it('an agent with no answer yet, or no such agent', async () => {
    const { dir } = board();
    const { h } = host({ dir });
    expect((await h.get('project_said').run({ agent: 'chatgpt', project: 'tip' })).note).toMatch(/hasn't answered/i);
    expect((await h.get('project_said').run({ agent: 'zorbo', project: 'tip' })).error).toMatch(/don't have an agent/);
  });
});

describe('what the team is doing', () => {
  it('who is on what, and what waits for your yes', async () => {
    const { dir, ps } = board();
    planFromSteps(ps, ['Build the header', 'Research tip apps']);
    ps.upsertTask({ id: 'T-001', owner: 'opencode-deepseek', status: 'assigned' });
    ps.upsertTask({ id: 'T-002', owner: 'chatgpt', status: 'review' });
    const { h } = host({ dir });
    const r = await h.get('team_status').run({});
    expect(r.note).toMatch(/DeepSeek.*T-001/);
    expect(r.note).toMatch(/T-002.*your yes/);
  });
  it('nothing going on', async () => {
    const { dir } = board();
    const { h } = host({ dir });
    expect((await h.get('team_status').run({})).note).toMatch(/isn't working on anything/);
  });
});

describe('stop the team', () => {
  it('a running coder is stopped, its task goes back to planned, nothing new starts, and it is not counted against the coder', async () => {
    const { dir, ps } = board();
    planFromSteps(ps, ['Build the header', 'Build the footer']);
    for (const t of ps.tasks()) ps.upsertTask({ id: t.id, depends_on: [] });
    const { h } = host({ dir });
    let started = 0;
    let stopped = 0;
    team().add({
      id: 'slow', name: 'Slow', roles: ['build'], order: 0, levels: { easy: 0, medium: 0, hard: 0 }, available: async () => ({ ok: true }),
      run: (pkg, { signal }) => new Promise((resolve) => {
        started += 1;
        signal?.addEventListener('abort', () => { stopped += 1; resolve({ ok: false, error: 'stopped' }); });
      }),
    });
    await h.get('project_run').run({ project: 'Tip', agent: 'slow' });
    await vi.waitFor(() => expect(started).toBe(1));
    const r = await h.get('project_stop').run({ project: 'Tip' });
    expect(r.note).toMatch(/Stopped the team on Tip/);
    await vi.waitFor(() => expect(stopped).toBe(1));
    await new Promise((res) => setTimeout(res, 100));
    expect(started).toBe(1); // the second task never started
    expect(ps.tasks().map((t) => t.status)).toEqual(['planned', 'planned']);
    expect(ps.tasks().find((x) => x.id === 'T-001').note).toMatch(/Stopped by you/);
    const recFile = path.join(h.runtime.dataDir, 'agents', 'record.json');
    expect(fs.existsSync(recFile) ? fs.readFileSync(recFile, 'utf8') : '').not.toMatch(/slow/);
  });
  it('nothing running: says so', async () => {
    const { dir } = board();
    const { h } = host({ dir });
    expect((await h.get('project_stop').run({ project: 'Tip' })).note).toMatch(/isn't running/);
  });
});

describe('undo the last task', () => {
  function repo() {
    const remote = tmp('novi-undo-remote-');
    git(remote, 'init', '-q', '--bare');
    const dir = tmp('novi-undo-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'The User');
    git(dir, 'config', 'user.email', 'user@example.com');
    fs.writeFileSync(path.join(dir, 'a.js'), 'a1\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.novi/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'start');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'main');
    return { dir, remote };
  }
  it('the task\'s commit is reverted under your name and pushed; the task is marked undone', async () => {
    const { dir, remote } = repo();
    const { h, rt } = host({ dir, commit: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'a2 agent\n');
    const c = await rt.commitFiles({ path: dir, name: 'Tip', files: ['a.js'], message: 'T-001: Change a' });
    expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir, goal: 'x' });
    planFromSteps(ps, ['Change a']);
    ps.upsertTask({ id: 'T-001', status: 'merged', commit: c.commit });
    // Undo trusts only Novi's own record of the commits your yes made, never the board (an agent can write it).
    const bogus = await h.get('project_undo').run({ project: 'Tip' });
    expect(bogus.note).toMatch(/nothing.*to undo/i);
    fs.mkdirSync(path.join(rt.dataDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(rt.dataDir, 'agents', 'merged.json'), JSON.stringify([{ project: path.resolve(dir).toLowerCase(), task: 'T-001', commit: c.commit }]));
    const r = await h.get('project_undo').run({ project: 'Tip' });
    expect(r.note).toMatch(/Undid T-001/);
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').trim()).toBe('a1'); // line endings follow your git settings
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'main').trim()).toMatch(/^The User\|Revert/);
    expect(ps.tasks()[0]).toMatchObject({ status: 'cancelled' });
  });
  it("a commit that isn't the task's own is never reverted", async () => {
    const { dir } = repo();
    const { rt } = host({ dir, commit: true });
    const start = git(dir, 'rev-parse', 'HEAD').trim();
    const r = await rt.revertCommit({ path: dir, name: 'Tip', commit: start, subject: 'T-001:' });
    expect(r).toMatchObject({ ok: false });
    expect(r.note).toMatch(/doesn't look like the task's own/);
  });
  it('nothing merged yet: says so', async () => {
    const { dir } = repo();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir, goal: 'x' });
    const { h } = host({ dir, commit: true });
    expect((await h.get('project_undo').run({ project: 'Tip' })).note).toMatch(/nothing.*to undo/i);
  });
  it('the AI asks before undoing; your own words do not', async () => {
    const { dir } = repo();
    const { h } = host({ dir, commit: true });
    expect((await h.gate(h.get('project_undo'), { project: 'Tip' }, {})).approval?.title).toMatch(/Undo/);
    expect((await h.gate(h.get('project_undo'), { project: 'Tip' }, { direct: true })).approval).toBeUndefined();
  });
});
