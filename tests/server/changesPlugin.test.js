import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseNumstat, gitChanges, changeSummary, fromTaskFiles } from '../../plugins/changes/changes.js';
import { testCommand, parseTestOutput, testSummary } from '../../plugins/changes/tests.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createChangesPlugin } from '../../plugins/changes/index.js';
import { changesCommand } from '../../server/brain/changesCommand.js';

// "See test results and changes on the phone" (Novi Build List, 2026-10-29): what Claude changed, and
// the project's own tests, said short and shown in the chat — no AI.
describe('what Claude changed', () => {
  it('reads git numstat (binary files have no line counts)', () => {
    expect(parseNumstat('20\t3\tsrc/App.jsx\n5\t0\tstyles.css\n-\t-\tlogo.png\n')).toEqual([
      { file: 'src/App.jsx', added: 20, removed: 3 },
      { file: 'styles.css', added: 5, removed: 0 },
      { file: 'logo.png', added: null, removed: null },
    ]);
  });

  it('git: changed files since the last commit, plus new ones', async () => {
    const exec = async (args) => {
      if (args[0] === 'rev-parse') return 'true\n';
      if (args[0] === 'diff') return '20\t3\tsrc/App.jsx\n';
      if (args[0] === 'status') return ' M src/App.jsx\n?? utils.js\n?? notes/\n';
      return '';
    };
    expect(await gitChanges('C:/p', { exec })).toEqual([
      { file: 'src/App.jsx', added: 20, removed: 3 },
      { file: 'utils.js', added: null, removed: null, isNew: true },
      { file: 'notes/', added: null, removed: null, isNew: true },
    ]);
    expect(await gitChanges('C:/p', { exec: async () => { throw new Error('not a git repository'); } })).toBeNull();
  });

  it('says it short; long lists end with "and N more"', () => {
    expect(changeSummary([{ file: 'src/App.jsx', added: 20, removed: 3 }, { file: 'utils.js', isNew: true }])).toBe('Claude changed 2 files: App.jsx (+20 −3) and utils.js (new).');
    const many = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'].map((file) => ({ file, added: 1, removed: 0 }));
    expect(changeSummary(many)).toBe('Claude changed 6 files: a.js (+1 −0), b.js (+1 −0), c.js (+1 −0), d.js (+1 −0) and 2 more.');
    expect(changeSummary([])).toBe('Nothing has changed since the last commit.');
  });

  it("no git: the files Claude wrote in the last task", () => {
    expect(fromTaskFiles(['C:\\p\\src\\App.jsx', 'C:\\p\\index.html', 'C:\\other\\x.js'], 'C:\\p')).toEqual([
      { file: 'src/App.jsx', added: null, removed: null },
      { file: 'index.html', added: null, removed: null },
    ]);
  });
});

describe("the project's own tests", () => {
  const dir = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-'));
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), text);
    }
    return d;
  };

  it('finds the test command', () => {
    expect(testCommand(dir({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }))).toBe('npm test');
    expect(testCommand(dir({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }))).toBeNull();
    expect(testCommand(dir({ 'pytest.ini': '[pytest]\n' }))).toBe('python -m pytest -q');
    expect(testCommand(dir({ 'tests/test_app.py': 'def test_x(): pass\n' }))).toBe('python -m pytest -q');
    expect(testCommand(dir({ 'index.html': '<p>hi</p>' }))).toBeNull();
  });

  it('reads vitest, jest, mocha and pytest results', () => {
    expect(parseTestOutput(' FAIL  src/tip.test.js > tip > adds 10%\n Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 45 passed (47)\n')).toEqual({ passed: 45, failed: 2, failedNames: ['tip > adds 10%'] });
    expect(parseTestOutput('  ● tip › splits the bill\nTests:       1 failed, 12 passed, 13 total\n')).toEqual({ passed: 12, failed: 1, failedNames: ['tip › splits the bill'] });
    expect(parseTestOutput('  8 passing (40ms)\n  1 failing\n')).toEqual({ passed: 8, failed: 1, failedNames: [] });
    expect(parseTestOutput('FAILED tests/test_app.py::test_total - assert 3 == 4\n==== 1 failed, 9 passed in 0.31s ====\n')).toEqual({ passed: 9, failed: 1, failedNames: ['test_total'] });
    expect(parseTestOutput('all good')).toBeNull();
  });

  it('says the result short and honest', () => {
    expect(testSummary({ passed: 45, failed: 0, failedNames: [] }, 0)).toBe('All 45 tests passed.');
    expect(testSummary({ passed: 45, failed: 2, failedNames: ['tip > adds 10%', 'splits'] }, 1)).toBe('45 passed, 2 failed: tip > adds 10%; splits.');
    expect(testSummary(null, 1, 'Error: Cannot find module x\n')).toBe("The tests didn't run cleanly (exit code 1), and I couldn't read a result. Last line: Error: Cannot find module x");
  });
});

describe('changes plugin', () => {
  function setup({ testOut = ' Tests  1 failed | 3 passed (4)\n FAIL  src/a.test.js > adds\n', code = 1 } = {}) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'changes-'));
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const said = [];
    const tasks = Object.assign(new EventEmitter(), { status: () => ({ active: true, path: d, files: [path.join(d, 'src', 'App.jsx')] }) });
    const runtime = { tasks, codingProject: (n) => (!n || /tip/i.test(n) ? { name: 'Tip calculator', path: d, working: false } : null), say: (t, o) => said.push([t, o]) };
    let gitOn = true;
    const git = async (args) => {
      if (!gitOn) throw new Error('not a git repository');
      if (args[0] === 'rev-parse') return 'true\n';
      if (args[0] === 'diff' && args.includes('--numstat')) return '20\t3\tsrc/App.jsx\n';
      if (args[0] === 'diff') return '@@ -1,2 +1,3 @@\n-old line\n+new line\n+another\n';
      if (args[0] === 'status') return ' M src/App.jsx\n';
      return '';
    };
    const ran = [];
    const run = async (command, cwd) => { ran.push([command, cwd]); return { code, output: testOut }; };
    const ph = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    expect(ph.register(createChangesPlugin({ git, run }))).toBe(true);
    return { d, said, tasks, ph, ran, tool: (name, args) => ph.get(name).run(args), gitOff: () => { gitOn = false; } };
  }

  it('"what did Claude change": the list, and one file\'s lines', async () => {
    const s = setup();
    expect((await s.tool('code_changes', { project: 'tip calculator' })).note).toBe('Claude changed 1 file: App.jsx (+20 −3).\n\n- src/App.jsx (+20 −3)\n\nSay "show me the changes in App.jsx" to see the lines.');
    const one = await s.tool('code_changes', { project: 'tip calculator', file: 'App.jsx' });
    expect(one.note).toContain('+new line');
    expect(one.note).toContain('-old line');
  });

  it('no git: the files Claude wrote, said honestly', async () => {
    const s = setup();
    s.gitOff();
    expect((await s.tool('code_changes', { project: 'tip calculator' })).note).toMatch(/^Tip calculator has no git, so here are the files Claude wrote last: src\/App\.jsx\.$/);
  });

  it('"run the tests": runs them in the background and says the result', async () => {
    const s = setup();
    expect((await s.tool('code_tests', { project: 'tip calculator' })).note).toBe("Running Tip calculator's tests (npm test). I'll tell you the result.");
    await new Promise((r) => setTimeout(r, 20));
    expect(s.ran).toEqual([['npm test', s.d]]);
    expect(s.said.at(-1)[0]).toBe('3 passed, 1 failed: adds.');
  });

  it('tells you what changed when Claude finishes', async () => {
    const s = setup();
    s.tasks.emit('task', { id: 't1', status: 'done', project: 'Tip calculator', path: s.d });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.said.at(-1)[0]).toBe('Claude changed 1 file: App.jsx (+20 −3). Say "show me the changes" or "run the tests".');
  });
});

describe('changes by voice (no AI)', () => {
  it('changes', () => {
    expect(changesCommand('what did Claude change')).toEqual({ tool: 'code_changes', args: {} });
    expect(changesCommand('show me the changes in App.jsx')).toEqual({ tool: 'code_changes', args: { file: 'App.jsx' } });
    expect(changesCommand('what changed in tip calculator')).toEqual({ tool: 'code_changes', args: { project: 'tip calculator' } });
    expect(changesCommand('show me the diff')).toEqual({ tool: 'code_changes', args: {} });
  });

  it('tests', () => {
    expect(changesCommand('run the tests')).toEqual({ tool: 'code_tests', args: {} });
    expect(changesCommand('did the tests pass?')).toEqual({ tool: 'code_tests', args: {} });
    expect(changesCommand('run the tests on portfolio')).toEqual({ tool: 'code_tests', args: { project: 'portfolio' } });
  });

  it('leaves everything else alone', () => {
    for (const t of ['run the checks', 'what changed in the news today', 'show me the code', 'change it to blue']) expect(changesCommand(t)).toBeNull();
  });
});
