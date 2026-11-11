import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openProjectState, TASK_STATES, taskFromCoder } from '../../plugins/project-state/state.js';
import { projectFacts } from '../../plugins/project-state/facts.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createProjectStatePlugin } from '../../plugins/project-state/index.js';

// Multi-agent orchestrator, Phase 1 (user, 2026-11-11): one record per project in <project>/.novi/ that
// every agent works from: project.json, tasks.json, context.md, decisions.md, audit-log.jsonl.
const tmpProject = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ps-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};
// Built at run time, so this file never holds anything that looks like a real key (Novi's commit scanner blocks those).
const FAKE_KEY = ['sk', 'abcdefghij'.repeat(3)].join('-');
const read = (dir, name) => fs.readFileSync(path.join(dir, '.novi', name), 'utf8');
const clock = () => { let t = Date.parse('2026-11-11T10:00:00Z'); return { now: () => t, tick: (ms = 1000) => { t += ms; } }; };

describe('project facts, gathered without any AI', () => {
  it('reads the goal from the README, the tech from package.json and the branch from git', () => {
    const dir = tmpProject({
      'README.md': '# Tip calculator\n\nSplits a bill between friends, with tip.\n\n## Setup\nnpm i',
      'package.json': JSON.stringify({ name: 'tip-calc', dependencies: { react: '18', express: '4' }, devDependencies: { vitest: '1' } }),
    });
    const exec = (cmd, args) => (args.includes('--abbrev-ref') ? 'main\n' : args.includes('log') ? 'abc123 Add tip slider\ndef456 First commit\n' : '');
    const f = projectFacts(dir, { name: 'Tip calculator', exec });
    expect(f).toMatchObject({ id: 'tip-calculator', name: 'Tip calculator', path: dir, goal: 'Splits a bill between friends, with tip.', current_branch: 'main' });
    expect(f.tech_stack).toEqual(expect.arrayContaining(['React', 'Express']));
    expect(f.recent_commits).toEqual(['abc123 Add tip slider', 'def456 First commit']);
  });
  it('a folder with no README or git still gives its name', () => {
    const dir = tmpProject();
    const f = projectFacts(dir, { name: 'Empty', exec: () => { throw new Error('not a git repo'); } });
    expect(f).toMatchObject({ id: 'empty', name: 'Empty', goal: '', current_branch: null, tech_stack: [] });
  });
});

describe('the project record', () => {
  it('writes project.json, context.md and decisions.md, and keeps created_at on later updates', () => {
    const dir = tmpProject();
    const c = clock();
    const ps = openProjectState(dir, { now: c.now });
    ps.ensure({ id: 'x', name: 'X', path: dir, goal: 'Do X', tech_stack: ['React'], current_branch: 'main' });
    const first = JSON.parse(read(dir, 'project.json'));
    expect(first).toMatchObject({ id: 'x', name: 'X', goal: 'Do X', status: 'active', created_at: '2026-11-11T10:00:00.000Z' });
    c.tick(60_000);
    ps.ensure({ id: 'x', name: 'X', path: dir, goal: 'Do X better', tech_stack: ['React'], current_branch: 'dev' });
    const second = JSON.parse(read(dir, 'project.json'));
    expect(second.created_at).toBe(first.created_at);
    expect(second).toMatchObject({ goal: 'Do X better', current_branch: 'dev', updated_at: '2026-11-11T10:01:00.000Z' });
    expect(read(dir, 'context.md')).toMatch(/# X[\s\S]*Do X better[\s\S]*React/);
    expect(read(dir, 'decisions.md')).toMatch(/^# Decisions/);
  });

  it('never writes outside <project>/.novi and leaves no half-written files', () => {
    const dir = tmpProject();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'x', name: 'X', path: dir });
    const top = fs.readdirSync(dir);
    expect(top).toEqual(['.novi']);
    expect(fs.readdirSync(path.join(dir, '.novi')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('a broken tasks.json is kept aside, not lost, and a fresh board starts', () => {
    const dir = tmpProject();
    fs.mkdirSync(path.join(dir, '.novi'));
    fs.writeFileSync(path.join(dir, '.novi', 'tasks.json'), '{ broken');
    const ps = openProjectState(dir);
    expect(ps.tasks()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, '.novi')).some((f) => f.startsWith('tasks.json.broken-'))).toBe(true);
  });
});

describe('the task board', () => {
  it('knows the ten states from the spec', () => {
    expect(TASK_STATES).toEqual(['planned', 'assigned', 'waiting_approval', 'review', 'changes_requested', 'approved', 'merged', 'failed', 'blocked', 'cancelled']);
  });
  it('adds and moves a task, keeping its history', () => {
    const dir = tmpProject();
    const c = clock();
    const ps = openProjectState(dir, { now: c.now });
    ps.upsertTask({ id: 't1', title: 'Add dark mode', owner: 'claude', status: 'assigned' });
    c.tick();
    ps.upsertTask({ id: 't1', status: 'review', summary: 'Dark mode added.' });
    const [t] = ps.tasks();
    expect(t).toMatchObject({ id: 't1', title: 'Add dark mode', owner: 'claude', status: 'review', summary: 'Dark mode added.' });
    expect(t.history.map((h) => h.status)).toEqual(['assigned', 'review']);
    expect(JSON.parse(read(dir, 'tasks.json')).tasks).toHaveLength(1);
  });
  it('refuses a state that does not exist', () => {
    const ps = openProjectState(tmpProject());
    expect(() => ps.upsertTask({ id: 't1', title: 'x', status: 'doing' })).toThrow(/state/i);
  });
  it('every move is written to the audit log', () => {
    const dir = tmpProject();
    const ps = openProjectState(dir);
    ps.upsertTask({ id: 't1', title: 'Add dark mode', owner: 'claude', status: 'assigned' });
    ps.upsertTask({ id: 't1', status: 'review' });
    const lines = read(dir, 'audit-log.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.action, l.task, l.to])).toEqual([['task', 't1', 'assigned'], ['task', 't1', 'review']]);
  });
  it('context.md lists open and finished work', () => {
    const dir = tmpProject();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'x', name: 'X', path: dir, goal: 'Do X' });
    ps.upsertTask({ id: 't1', title: 'Add dark mode', owner: 'claude', status: 'merged' });
    ps.upsertTask({ id: 't2', title: 'Add login', owner: 'claude', status: 'assigned' });
    const md = read(dir, 'context.md');
    expect(md).toMatch(/Active tasks[\s\S]*Add login/);
    expect(md).toMatch(/Completed work[\s\S]*Add dark mode/);
  });
});

describe('decisions', () => {
  it('are added to decisions.md with date, owner and reason, and listed back', () => {
    const dir = tmpProject();
    const ps = openProjectState(dir, { now: clock().now });
    ps.addDecision({ title: 'Database', decision: 'Use PostgreSQL', reason: 'Relational data', owner: 'User' });
    expect(read(dir, 'decisions.md')).toMatch(/## 2026-11-11 — Database\nDecision: Use PostgreSQL\nReason: Relational data\nOwner: User\nStatus: Accepted/);
    expect(ps.decisions()).toEqual([{ date: '2026-11-11', title: 'Database', decision: 'Use PostgreSQL', reason: 'Relational data', owner: 'User', status: 'Accepted' }]);
  });
  it('anything that looks like a secret is never written', () => {
    const ps = openProjectState(tmpProject());
    expect(() => ps.addDecision({ title: 'Keys', decision: `Use key ${FAKE_KEY}` })).toThrow(/secret/i);
  });
});

describe('a coding task becomes a board task', () => {
  it('maps the coder\'s states', () => {
    const base = { id: 'a1', project: 'X', path: 'C:/x', instruction: 'add dark mode to the settings page', agent: 'Claude Code' };
    expect(taskFromCoder({ ...base, status: 'running' })).toMatchObject({ id: 'a1', title: 'add dark mode to the settings page', owner: 'claude', status: 'assigned' });
    expect(taskFromCoder({ ...base, status: 'done', summary: 'Done it.' })).toMatchObject({ status: 'review', summary: 'Done it.' });
    expect(taskFromCoder({ ...base, status: 'failed' }).status).toBe('failed');
    expect(taskFromCoder({ ...base, status: 'stopped' }).status).toBe('cancelled');
    expect(taskFromCoder({ ...base, status: 'running', agent: 'Novi Coder' }).owner).toBe('novi-coder');
    expect(taskFromCoder({ active: false })).toBe(null);
  });
});

describe('the plugin', () => {
  function setup({ projects = [] } = {}) {
    const tasks = new EventEmitter();
    const host = new PluginHost({ runtime: { tasks, projects: { list: () => projects }, codingProject: (n) => projects.find((p) => p.name.toLowerCase() === String(n || '').toLowerCase()) || null }, env: {}, logger: { warn() {}, info() {} } });
    expect(host.register(createProjectStatePlugin({ exec: () => '' }))).toBe(true);
    return { host, tasks };
  }
  it('follows Claude\'s task onto the project\'s board', async () => {
    const dir = tmpProject({ 'README.md': '# X\n\nDoes X.' });
    const { tasks } = setup({ projects: [{ name: 'X', path: dir }] });
    tasks.emit('task', { active: true, id: 'a1', project: 'X', path: dir, instruction: 'add login', status: 'running', agent: 'Claude Code' });
    tasks.emit('task', { active: true, id: 'a1', project: 'X', path: dir, instruction: 'add login', status: 'done', summary: 'Login added.', agent: 'Claude Code' });
    await new Promise((r) => setTimeout(r, 20));
    const ps = openProjectState(dir);
    expect(ps.tasks()[0]).toMatchObject({ id: 'a1', status: 'review', summary: 'Login added.' });
    expect(ps.project()).toMatchObject({ name: 'X', goal: 'Does X.' });
  });
  it('after a restart, a task that was still running is marked blocked, not lost', async () => {
    const dir = tmpProject();
    openProjectState(dir).upsertTask({ id: 'old', title: 'add login', owner: 'claude', status: 'assigned' });
    const { host } = setup({ projects: [{ name: 'X', path: dir }] });
    await host.startServices?.();
    const t = openProjectState(dir).tasks()[0];
    expect(t.status).toBe('blocked');
    expect(t.note).toMatch(/restarted/i);
  });
  it('project_board answers from the record; project_decision writes a decision', async () => {
    const dir = tmpProject();
    const { host } = setup({ projects: [{ name: 'X', path: dir }] });
    openProjectState(dir).upsertTask({ id: 't1', title: 'Add login', owner: 'claude', status: 'assigned' });
    const board = await host.get('project_board').run({ project: 'X' });
    expect(board.note).toMatch(/1 open task[\s\S]*Add login/);
    const dec = await host.get('project_decision').run({ project: 'X', title: 'Auth', decision: 'Use JWT', reason: 'Simple' });
    expect(dec.note).toMatch(/Noted the decision/);
    expect(openProjectState(dir).decisions()[0]).toMatchObject({ title: 'Auth', decision: 'Use JWT' });
  });
  it('an unknown project is said plainly', async () => {
    const { host } = setup();
    expect((await host.get('project_board').run({ project: 'Nope' })).error).toMatch(/don't know/i);
  });
});

describe('the board and decisions by voice (no AI)', async () => {
  const { projectBoardCommand } = await import('../../server/brain/projectBoardCommand.js');
  it('reads the board', () => {
    expect(projectBoardCommand('show me the Tip calculator board')).toEqual({ tool: 'project_board', args: { project: 'Tip calculator' } });
    expect(projectBoardCommand("what's on the novi board?")).toEqual({ tool: 'project_board', args: { project: 'novi' } });
    expect(projectBoardCommand('task board for portfolio')).toEqual({ tool: 'project_board', args: { project: 'portfolio' } });
  });
  it('writes a decision in the user\'s own words', () => {
    expect(projectBoardCommand('decision for Tip calculator: use React because it is simple')).toEqual({ tool: 'project_decision', args: { project: 'Tip calculator', title: 'use React', decision: 'use React', reason: 'it is simple' } });
    expect(projectBoardCommand('note a decision for novi: database is SQLite')).toEqual({ tool: 'project_decision', args: { project: 'novi', title: 'database is SQLite', decision: 'database is SQLite', reason: '' } });
  });
  it('leaves other sentences alone', () => {
    expect(projectBoardCommand('what is the status of novi')).toBe(null);
    expect(projectBoardCommand('board the plane')).toBe(null);
  });
});

// Code review 2026-11-11.
describe('review fixes', () => {
  it('a coder task whose summary looks like a secret still moves; only that text is left out', () => {
    const dir = tmpProject();
    const ps = openProjectState(dir);
    ps.upsertTask({ id: 't1', title: 'add login', owner: 'claude', status: 'assigned' }, { redact: true });
    ps.upsertTask({ id: 't1', status: 'review', summary: `Set API key ${FAKE_KEY} in config` }, { redact: true });
    const [t] = ps.tasks();
    expect(t.status).toBe('review');
    expect(t.summary).toMatch(/left out/i);
    expect(read(dir, 'tasks.json')).not.toContain(FAKE_KEY);
  });
  it('keeps its own files out of git, but not run.json or checks.json', () => {
    const dir = tmpProject();
    openProjectState(dir).ensure({ id: 'x', name: 'X', path: dir });
    const ignore = read(dir, '.gitignore');
    expect(ignore).toMatch(/tasks\.json/);
    expect(ignore).toMatch(/audit-log\.jsonl/);
    expect(ignore).not.toMatch(/run\.json|checks\.json|^\*$/m);
  });
  it('a project folder that is gone is never made again', () => {
    const gone = path.join(os.tmpdir(), `novi-ps-gone-${Date.now()}`);
    expect(() => openProjectState(gone).upsertTask({ id: 't1', title: 'x', status: 'assigned' })).toThrow(/folder/i);
    expect(fs.existsSync(gone)).toBe(false);
  });
  it('the same move twice writes nothing the second time', () => {
    const dir = tmpProject();
    const ps = openProjectState(dir);
    ps.upsertTask({ id: 't1', title: 'add login', owner: 'claude', status: 'assigned' });
    const before = fs.statSync(path.join(dir, '.novi', 'tasks.json')).mtimeMs;
    const lines = read(dir, 'audit-log.jsonl');
    ps.upsertTask({ id: 't1', title: 'add login', owner: 'claude', status: 'assigned' });
    expect(fs.statSync(path.join(dir, '.novi', 'tasks.json')).mtimeMs).toBe(before);
    expect(read(dir, 'audit-log.jsonl')).toBe(lines);
  });
});

describe('goal text', async () => {
  const { goalFrom } = await import('../../plugins/project-state/facts.js');
  it('drops Markdown marks and links', () => {
    expect(goalFrom('# Novi\n\n**A voice-first _AI_ companion** for [your laptop](https://x.y) and `code`.')).toBe('A voice-first AI companion for your laptop and code.');
  });
});

describe('Phase 2 wiring', async () => {
  const { claudeArgs } = await import('../../server/claude/session.js');
  const { projectBoardCommand } = await import('../../server/brain/projectBoardCommand.js');
  it('every Claude run is told to read the project record first and not to edit it', () => {
    const prompt = claudeArgs()[claudeArgs().indexOf('--append-system-prompt') + 1];
    expect(prompt).toMatch(/\.novi\/context\.md/);
    expect(prompt).toMatch(/never rebuild/i);
  });
  it('"plan the X project" plans it', () => {
    expect(projectBoardCommand('plan the tip calculator project')).toEqual({ tool: 'project_plan', args: { project: 'tip calculator' } });
    expect(projectBoardCommand('make a plan for portfolio')).toEqual({ tool: 'project_plan', args: { project: 'portfolio' } });
    expect(projectBoardCommand('break novi into tasks')).toEqual({ tool: 'project_plan', args: { project: 'novi' } });
  });
});
