import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseReport, checkTask, reviewCard } from '../../plugins/agents/review.js';
import { openProjectState } from '../../plugins/project-state/state.js';
import { planFromSteps, readyTasks } from '../../plugins/project-state/planner.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createAgentsPlugin } from '../../plugins/agents/index.js';

// Multi-agent orchestrator, Phase 4 (2026-11-12). User: "every AI is answerable to Novi… the AIs report to
// Novi and Novi then reports to me". Every finished task comes back in one shape (files, tests, risks,
// questions), Novi checks it itself, and one card asks the user: approve, or send it back with what to change.
// Nothing after it starts until the user approves.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-review-'));

describe('the report every agent gives', () => {
  it('reads files, tests, risks and questions from the answer, however it is marked up', () => {
    const r = parseReport('Did the thing.\n\n**Files changed:**\n- src/a.js\n- src/b.css\n\nTests: 12 passed, 0 failed\n\n## Risks\n- the API key is read from the page\n\nQuestions:\n- Should dark mode be the default?');
    expect(r.files).toEqual(['src/a.js', 'src/b.css']);
    expect(r.tests).toBe('12 passed, 0 failed');
    expect(r.risks).toEqual(['the API key is read from the page']);
    expect(r.questions).toEqual(['Should dark mode be the default?']);
    expect(r.has).toBe(true);
  });
  it('an answer with no report says so', () => {
    expect(parseReport('Here are three APIs: A, B, C.')).toMatchObject({ has: false, files: [], risks: [], questions: [] });
  });
});

describe('Novi checks the work itself', () => {
  it('a build: the files that changed, the tests run, and a forbidden file is a problem', async () => {
    const check = await checkTask({
      task: { id: 'T-1', role: 'build' }, dir: tmp(), output: '',
      changes: async () => [{ file: 'src/a.js' }, { file: '.env' }],
      runTests: async () => ({ ran: true, ok: true, summary: 'All 12 tests passed.' }),
    });
    expect(check.files).toEqual(['src/a.js', '.env']);
    expect(check.tests).toMatchObject({ ok: true, summary: 'All 12 tests passed.' });
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toMatch(/\.env/);
  });
  it('a build with failing tests is not ok; with passing tests and safe files it is', async () => {
    const bad = await checkTask({ task: { id: 'T-1', role: 'build' }, dir: tmp(), changes: async () => [{ file: 'a.js' }], runTests: async () => ({ ran: true, ok: false, summary: '3 passed, 2 failed.' }) });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/2 failed/);
    const good = await checkTask({ task: { id: 'T-1', role: 'build' }, dir: tmp(), changes: async () => [{ file: 'a.js' }], runTests: async () => ({ ran: true, ok: true, summary: 'All 5 tests passed.' }) });
    expect(good.ok).toBe(true);
  });
  it('a text answer: a partial or empty answer is a problem; its questions are passed on', async () => {
    const partial = await checkTask({ task: { id: 'T-1', role: 'research', note: 'Partial: the site stopped early.' }, dir: tmp(), output: 'Some text' });
    expect(partial.ok).toBe(false);
    const empty = await checkTask({ task: { id: 'T-1', role: 'plan' }, dir: tmp(), output: '  ' });
    expect(empty.ok).toBe(false);
    const fine = await checkTask({ task: { id: 'T-1', role: 'research' }, dir: tmp(), output: 'A table.\n\nQuestions:\n- Which one do you like?' });
    expect(fine).toMatchObject({ ok: true, questions: ['Which one do you like?'] });
  });
});

describe('the one card the user gets', () => {
  it('says who did what and what Novi found, and asks approve or send back', () => {
    const card = reviewCard({ project: 'Tip', task: { id: 'T-3', title: 'Build the inputs' }, agentName: 'Claude', check: { ok: true, files: ['a.js', 'b.js'], tests: { ran: true, ok: true, summary: 'All 12 tests passed.' }, problems: [], risks: [], questions: [] } });
    expect(card.title).toMatch(/Tip.*T-3.*Build the inputs.*Claude/);
    expect(card.prompt).toMatch(/Claude finished T-3 for Tip.*2 files.*All 12 tests passed.*Approve/i);
    expect(card.changeable).toBe(true);
    expect(card.timeoutMs).toBe(null);
  });
  it('problems come first and are said', () => {
    const card = reviewCard({ project: 'Tip', task: { id: 'T-3', title: 'Build' }, agentName: 'Claude', check: { ok: false, files: [], tests: { ran: true, ok: false, summary: '3 passed, 2 failed.' }, problems: ['Tests: 3 passed, 2 failed.'], risks: [], questions: [] } });
    expect(card.prompt).toMatch(/but.*2 failed.*approve anyway, or send it back/i);
  });
});

describe('nothing after a task starts until the user approves it', () => {
  it('a task in review does not unblock the next one; approved does', () => {
    const tasks = [{ id: 'T-001', status: 'review' }, { id: 'T-002', status: 'planned', depends_on: ['T-001'] }];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual([]);
    tasks[0].status = 'approved';
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(['T-002']);
  });
});

describe('the plugin: report → check → card → approve / send back', () => {
  function setup({ answers }) {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir });
    planFromSteps(ps, ['Research tip apps', 'Write the spec for the inputs']);
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: false });
    const cards = [];
    const said = [];
    const seen = [];
    const rt = {
      tasks, say: (t) => said.push(t), notice: () => {}, logger: { warn() {}, info() {} },
      complete: async (pkg) => { seen.push(pkg); return `Answer for ${/Task ID: (\S+)/.exec(pkg)?.[1]}.\n\nQuestions:\n- none`; },
      projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: () => ({ name: 'Tip', path: dir }),
      browserStatus: () => ({ connected: false }),
      ask: async (card) => { cards.push(card); return answers.shift() || { allow: false }; },
    };
    const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    host.register(createAgentsPlugin({ exec: async () => { throw new Error('none'); } }));
    return { host, dir, cards, said, seen };
  }
  const settle = () => new Promise((r) => setTimeout(r, 120));

  it('approve → the task is approved and the next one runs, then its own card', async () => {
    const { host, dir, cards } = setup({ answers: [{ allow: true }, { allow: true }] });
    await host.get('project_run').run({ project: 'Tip' });
    await settle();
    const board = openProjectState(dir).tasks();
    expect(board.map((t) => [t.id, t.status]).sort()).toEqual([['T-001', 'approved'], ['T-002', 'approved']]);
    expect(cards).toHaveLength(2);
    expect(cards[0].title).toMatch(/T-001/);
  });
  it('send back with words → the same task runs again with what to change, and asks again', async () => {
    const { host, dir, cards, seen } = setup({ answers: [{ allow: false, change: 'add a price column' }, { allow: true }, { allow: false }] });
    await host.get('project_run').run({ project: 'Tip' });
    await settle();
    expect(seen[1]).toMatch(/The user asked for changes: add a price column/);
    expect(cards[1].title).toMatch(/T-001/);
    const t1 = openProjectState(dir).tasks().find((t) => t.id === 'T-001');
    expect(t1.status).toBe('approved');
  });
  it('a plain no → the task waits for changes and nothing after it runs', async () => {
    const { host, dir, said } = setup({ answers: [{ allow: false }] });
    await host.get('project_run').run({ project: 'Tip' });
    await settle();
    const board = openProjectState(dir).tasks();
    expect(board.find((t) => t.id === 'T-001').status).toBe('changes_requested');
    expect(board.find((t) => t.id === 'T-002').status).toBe('planned');
    expect(said.join(' ')).toMatch(/T-001 waits/);
  });
});

// Code review 2026-11-12.
describe('review fixes', () => {
  it('"none" is no entry; ** marks and comma lists are read right', () => {
    const r = parseReport('Done.\n\n**Files changed:** a.js, b.js\nTests: none\nRisks: none\nQuestions: none');
    expect(r.files).toEqual(['a.js', 'b.js']);
    expect(r.tests).toBe('');
    expect(r.risks).toEqual([]);
    expect(r.questions).toEqual([]);
  });
  it('a test run that exits with an error is not "all passed", even when the count says so', async () => {
    const { testsOk } = await import('../../plugins/agents/review.js');
    expect(testsOk({ passed: 10, failed: 0 }, 1)).toBe(false);
    expect(testsOk({ passed: 10, failed: 0 }, 0)).toBe(true);
    expect(testsOk(null, 0)).toBe(true);
  });
  it("the project's tests never get Novi's keys", async () => {
    const { testEnv } = await import('../../plugins/agents/review.js');
    const env = testEnv({ PATH: 'p', SystemRoot: 'C:\Windows', GROQ_API_KEYS: 'x', GEMINI_API_KEYS: 'y', TEMP: 't' });
    expect(env.PATH).toBe('p');
    expect(env.GROQ_API_KEYS).toBeUndefined();
    expect(env.GEMINI_API_KEYS).toBeUndefined();
  });
});

describe('plugin review fixes', () => {
  function setupWith({ board, answers = [], askThrows = false }) {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir });
    for (const t of board) ps.upsertTask(t);
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: false });
    const cards = [];
    const said = [];
    const rt = {
      tasks, say: (t) => said.push(t), notice: () => {}, logger: { warn() {}, info() {} }, complete: async () => 'ok\n\nRisks: none',
      projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: () => ({ name: 'Tip', path: dir }), browserStatus: () => ({ connected: false }),
      ask: async (card) => { cards.push(card); if (askThrows) throw new Error('card failed'); return answers.shift() || { allow: false }; },
    };
    const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    host.register(createAgentsPlugin({ exec: async () => { throw new Error('none'); }, review: { changes: async () => [], runTests: async () => ({ ran: false, ok: true, summary: 'No tests.' }) } }));
    return { host, dir, cards, said };
  }
  const settle = () => new Promise((r) => setTimeout(r, 120));
  it('a task left in review (after a restart) gets its card again on "run"', async () => {
    const { host, cards } = setupWith({ board: [{ id: 'T-001', title: 'Research', role: 'research', status: 'review', owner: 'backup' }, { id: 'T-002', title: 'Spec', role: 'plan', status: 'planned', depends_on: ['T-001'] }], answers: [{ allow: false }] });
    const out = await host.get('project_run').run({ project: 'Tip' });
    await settle();
    expect(out.error).toBeUndefined();
    expect(cards[0].title).toMatch(/T-001/);
  });
  it('a failed task is retried on "run"', async () => {
    const { host, dir } = setupWith({ board: [{ id: 'T-001', title: 'Research', role: 'research', status: 'failed' }], answers: [{ allow: true }] });
    await host.get('project_run').run({ project: 'Tip' });
    await settle();
    expect(openProjectState(dir).tasks()[0].status).toBe('approved');
  });
  it('a card Novi closed or that timed out leaves the task in review, not "waits"', async () => {
    const { host, dir, said } = setupWith({ board: [{ id: 'T-001', title: 'Research', role: 'research', status: 'review', owner: 'backup' }], answers: [{ allow: false, closed: true }] });
    await host.get('project_run').run({ project: 'Tip' });
    await settle();
    expect(openProjectState(dir).tasks()[0].status).toBe('review');
    expect(said.join(' ')).not.toMatch(/waits/);
  });
});

// Live 2026-11-12: a research card said "1 file changed, API documentation reviewed" (ChatGPT's own lines).
describe('a text task card shows no files or tests', () => {
  it('files and tests are only for building; questions and risks still come through', async () => {
    const check = await checkTask({ task: { id: 'T-1', role: 'research' }, dir: tmp(), output: 'A table.\n\nFiles changed:\n- notes.md\nTests: API documentation reviewed\nRisks:\n- one API may close\nQuestions: none' });
    expect(check.files).toEqual([]);
    expect(check.tests).toBe(null);
    expect(check.risks).toEqual(['one API may close']);
    const card = reviewCard({ project: 'Tip', task: { id: 'T-1', title: 'Research' }, agentName: 'ChatGPT', check });
    expect(card.prompt).toBe('ChatGPT finished T-1 for Tip. Approve?');
  });
});

// Live 2026-11-12: "2 files changed" counted Novi's own .novi folder.
describe("Novi's own record is not the agent's work", () => {
  it('.novi files are left out of the changed files', async () => {
    const check = await checkTask({ task: { id: 'T-1', role: 'build' }, dir: tmp(), changes: async () => [{ file: 'index.html' }, { file: '.novi/' }, { file: '.novi/tasks.json' }], runTests: async () => ({ ran: false, ok: true, summary: 'No tests.' }) });
    expect(check.files).toEqual(['index.html']);
  });
});

// Security review 2026-11-12: an agent that changed the test setup must not get its code run by Novi.
describe('Novi never runs tests the agent rewired', () => {
  it('changed package.json / test config / git settings: tests are not run, and the card says why', async () => {
    let ran = 0;
    const check = await checkTask({ task: { id: 'T-1', role: 'build' }, dir: tmp(), changes: async () => [{ file: 'src/a.js' }, { file: 'package.json' }], runTests: async () => { ran += 1; return { ran: true, ok: true, summary: 'All passed.' }; } });
    expect(ran).toBe(0);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toMatch(/package\.json.*didn't run the tests/i);
  });
  it('git runs with no keys and with its risky settings off', async () => {
    const { gitArgs } = await import('../../plugins/agents/review.js');
    expect(gitArgs(['status', '--porcelain'])).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'core.pager=cat', '-c', 'diff.external=', '--no-optional-locks', 'status', '--porcelain']);
  });
  it('programs are never looked up in the project folder first', async () => {
    const { testEnv } = await import('../../plugins/agents/review.js');
    expect(testEnv({ PATH: 'p' }).NoDefaultCurrentDirectoryInExePath).toBe('1');
  });
});
