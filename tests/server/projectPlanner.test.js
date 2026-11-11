import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openProjectState } from '../../plugins/project-state/state.js';
import { stepsFromBrief, ownerFor, planFromSteps, readyTasks, taskPackage, similarDone } from '../../plugins/project-state/planner.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createProjectStatePlugin } from '../../plugins/project-state/index.js';

// Multi-agent orchestrator, Phase 2 (2026-11-11): the brief becomes tasks with owners, done-when lists and
// dependencies; the board is checked first so finished work is never rebuilt; each agent gets a task package.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-plan-'));
const BRIEF = [
  '## Goal (ChatGPT)', 'A tip calculator.',
  '## Steps (ChatGPT)', '1. Research tip calculator apps for ideas', '2. Build the bill and tip inputs', '3. Add a dark mode toggle', '4. Write tests for the tip maths', '5. Review the security of the inputs',
  '## Done when (ChatGPT)', '- Typing a bill shows the tip', '- Dark mode works',
].join('\n');

describe('steps from the brief', () => {
  it('reads the numbered steps and the done-when list', () => {
    const { steps, doneWhen } = stepsFromBrief(BRIEF);
    expect(steps).toEqual(['Research tip calculator apps for ideas', 'Build the bill and tip inputs', 'Add a dark mode toggle', 'Write tests for the tip maths', 'Review the security of the inputs']);
    expect(doneWhen).toEqual(['Typing a bill shows the tip', 'Dark mode works']);
  });
  it('a brief with no steps gives none', () => {
    expect(stepsFromBrief('just some words').steps).toEqual([]);
  });
});

describe('who owns a step (the spec\'s roles)', () => {
  it('research to Perplexity, planning to ChatGPT, review to Gemini, building to Claude', () => {
    expect(ownerFor('Research tip calculator apps for ideas')).toBe('perplexity');
    expect(ownerFor('Write the product spec and user flows')).toBe('chatgpt');
    expect(ownerFor('Review the security of the inputs')).toBe('gemini');
    expect(ownerFor('Build the bill and tip inputs')).toBe('claude');
    expect(ownerFor('Write tests for the tip maths')).toBe('claude');
  });
  it('the user\'s own choice wins', () => {
    expect(ownerFor('Build the frontend', { frontend: 'codex' })).toBe('codex');
  });
});

describe('planning onto the board', () => {
  it('adds planned tasks with owners, dependencies and done-when, in order', () => {
    const ps = openProjectState(tmp());
    const { steps, doneWhen } = stepsFromBrief(BRIEF);
    const out = planFromSteps(ps, steps, { doneWhen });
    expect(out.added).toHaveLength(5);
    const t = ps.tasks().reverse();
    expect(t.map((x) => [x.id, x.owner, x.status])).toEqual([['T-001', 'perplexity', 'planned'], ['T-002', 'claude', 'planned'], ['T-003', 'claude', 'planned'], ['T-004', 'claude', 'planned'], ['T-005', 'gemini', 'planned']]);
    expect(t[1].depends_on).toEqual(['T-001']);
    expect(t[2].depends_on).toEqual(['T-002']);
    expect(t[4].acceptance_criteria).toEqual(['Typing a bill shows the tip', 'Dark mode works']);
  });
  it('a step already finished on the board is not added again, and says so', () => {
    const ps = openProjectState(tmp());
    ps.upsertTask({ id: 'old', title: 'add a dark mode toggle to the settings', owner: 'claude', status: 'merged' });
    const out = planFromSteps(ps, ['Add a dark mode toggle', 'Add a history list']);
    expect(out.skipped).toEqual([{ step: 'Add a dark mode toggle', done: 'old' }]);
    expect(out.added.map((t) => t.title)).toEqual(['Add a history list']);
  });
  it('planning the same brief twice adds nothing the second time', () => {
    const ps = openProjectState(tmp());
    planFromSteps(ps, ['Build the inputs', 'Add dark mode']);
    const again = planFromSteps(ps, ['Build the inputs', 'Add dark mode']);
    expect(again.added).toEqual([]);
    expect(ps.tasks()).toHaveLength(2);
  });
  it('similarDone matches on the meaningful words only', () => {
    const board = [{ id: 'a', title: 'Add login page with email', status: 'merged' }, { id: 'b', title: 'Add dark mode', status: 'planned' }];
    expect(similarDone('add the login page', board)?.id).toBe('a');
    expect(similarDone('add dark mode', board)).toBe(null); // only planned, not finished
    expect(similarDone('add a footer', board)).toBe(null);
  });
});

describe('what can start now', () => {
  it('a task is ready when everything it depends on is finished', () => {
    const tasks = [
      { id: 'T-001', status: 'merged', depends_on: [] },
      { id: 'T-002', status: 'planned', depends_on: ['T-001'] },
      { id: 'T-003', status: 'planned', depends_on: ['T-002'] },
    ];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['T-002']);
  });
});

describe('the task package an agent gets', () => {
  it('has the project context, the task, finished work, decisions and the rules', () => {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir, goal: 'Split bills', tech_stack: ['React'], current_branch: 'main' });
    ps.addDecision({ title: 'Styling', decision: 'Plain CSS, no framework' });
    ps.upsertTask({ id: 'T-001', title: 'Build the inputs', owner: 'claude', status: 'merged', summary: 'Inputs done.' });
    ps.upsertTask({ id: 'T-002', title: 'Add dark mode', owner: 'claude', status: 'planned', depends_on: ['T-001'], acceptance_criteria: ['Dark mode works'] });
    const pkg = taskPackage(ps, 'T-002');
    for (const bit of ['PROJECT CONTEXT', 'Goal: Split bills', 'React', 'Branch: main', 'Build the inputs', 'Plain CSS, no framework', 'TASK', 'T-002', 'Add dark mode', 'Dark mode works', 'Do not rebuild completed work', 'Do not commit or push', 'secrets']) expect(pkg).toContain(bit);
  });
  it('an unknown task gives null', () => {
    expect(taskPackage(openProjectState(tmp()), 'nope')).toBe(null);
  });
});

describe('the plugin plans an approved brief', () => {
  function setup(projects) {
    const tasks = new EventEmitter();
    const handlers = {};
    const host = new PluginHost({ runtime: { tasks, projects: { list: () => projects }, codingProject: (n) => projects.find((p) => p.name.toLowerCase() === String(n || '').toLowerCase()) || null, wikiRead: (t) => (t === 'Tip brief' ? BRIEF : null) }, env: {}, logger: { warn() {}, info() {} } });
    expect(host.register(createProjectStatePlugin({ exec: () => '' }))).toBe(true);
    return { host, tasks, handlers };
  }
  it('project_plan plans from the project\'s brief note', async () => {
    const dir = tmp();
    const { host } = setup([{ name: 'Tip', path: dir }]);
    const out = await host.get('project_plan').run({ project: 'Tip' });
    expect(out.note).toMatch(/Planned 5 tasks for Tip/);
    expect(openProjectState(dir).tasks()).toHaveLength(5);
  });
  it('a brief-approved Claude run moves the planned building tasks with it', async () => {
    const dir = tmp();
    const { host, tasks } = setup([{ name: 'Tip', path: dir }]);
    const instruction = `Follow this brief (made by Novi with ChatGPT and Gemini):\n${BRIEF}`;
    // The run's own first event comes before anything else (TaskManager.start emits at once; code review).
    tasks.emit('task', { active: true, id: 'run1', project: 'Tip', path: dir, instruction, status: 'running', agent: 'Claude Code' });
    tasks.emit('task', { active: true, id: 'run1', project: 'Tip', path: dir, instruction, status: 'done', agent: 'Claude Code' });
    await new Promise((r) => setTimeout(r, 20));
    const board = openProjectState(dir).tasks();
    const claudeSteps = board.filter((t) => t.owner === 'claude' && t.id.startsWith('T-'));
    expect(claudeSteps.length).toBe(3);
    expect(claudeSteps.every((t) => t.status === 'review' && t.agent_run === 'run1')).toBe(true);
    expect(board.find((t) => t.owner === 'perplexity').status).toBe('planned'); // not Claude's step: untouched
  });
});

// Code review 2026-11-11.
describe('planner review fixes', () => {
  const brief = () => 'Follow this brief (made by Novi with ChatGPT and Gemini):\n' + BRIEF;
  it('an old plan that never ran is not moved by a new brief run', () => {
    const dir = tmp();
    openProjectState(dir).upsertTask({ id: 'T-001', title: 'Old step from yesterday', owner: 'claude', status: 'planned', source: 'brief' });
    const tasks = new EventEmitter();
    const host = new PluginHost({ runtime: { tasks, projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: () => ({ name: 'Tip', path: dir }) }, env: {}, logger: { warn() {}, info() {} } });
    host.register(createProjectStatePlugin({ exec: () => '' }));
    tasks.emit('task', { active: true, id: 'run2', project: 'Tip', path: dir, instruction: brief(), status: 'running', agent: 'Claude Code' });
    tasks.emit('task', { active: true, id: 'run2', project: 'Tip', path: dir, instruction: brief(), status: 'done', agent: 'Claude Code' });
    const old = openProjectState(dir).tasks().find((t) => t.id === 'T-001');
    expect(old.status).toBe('planned');
    expect(old.agent_run).toBeUndefined();
  });
  it('the link is kept on the board, so the run moves its steps even after a Novi restart', () => {
    const dir = tmp();
    openProjectState(dir).upsertTask({ id: 'T-003', title: 'Add dark mode', owner: 'claude', status: 'assigned', source: 'brief', agent_run: 'run9' });
    const tasks = new EventEmitter();
    const host = new PluginHost({ runtime: { tasks, projects: { list: () => [] } }, env: {}, logger: { warn() {}, info() {} } });
    host.register(createProjectStatePlugin({ exec: () => '' }));
    tasks.emit('task', { active: true, id: 'run9', project: 'Tip', path: dir, instruction: 'carry on', status: 'done', agent: 'Claude Code' });
    expect(openProjectState(dir).tasks().find((t) => t.id === 'T-003').status).toBe('review');
  });
  it('a finished "fix login page styling" is not "add login page"; one-word steps never match', () => {
    const board = [{ id: 'x', title: 'Fix login page styling', status: 'merged', source: 'brief' }, { id: 'y', title: 'Deploy the app to Vercel', status: 'merged', source: 'brief' }];
    expect(similarDone('Add login page', board)).toBe(null);
    expect(similarDone('Deploy', board)).toBe(null);
  });
  it('a coder run that only ended (review, no plan source) never counts as finished work', () => {
    expect(similarDone('Add the login page', [{ id: 'run', title: 'add the login page with email', status: 'review' }])).toBe(null);
  });
});
