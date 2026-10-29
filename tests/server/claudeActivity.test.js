import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeSessions, activityLine } from '../../plugins/claude-link/activity.js';
import { claudeActivityCommand } from '../../server/brain/claudeLinkCommand.js';

// Live 2026-10-29: "what is Claude working on?" → "Claude isn't working on any task right now" while a
// Claude Code session (started in the Claude app, not by Novi) was busy on NOVI. Claude Code writes every
// session to ~/.claude/projects/<folder>/<id>.jsonl — a file changed in the last minutes = working.
function sessionsDir(lines, { ageMs = 60_000, folder = 'C--dev-NOVI', id = 's1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  fs.mkdirSync(path.join(dir, folder));
  const file = path.join(dir, folder, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return dir;
}

const user = (content) => ({ type: 'user', cwd: 'C:\\dev\\NOVI', message: { role: 'user', content } });
const tool = (name, input) => ({ type: 'assistant', cwd: 'C:\\dev\\NOVI', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });

describe('what Claude Code is working on', () => {
  it('a session changed in the last minutes: its folder, the last request and the current step', () => {
    const dir = sessionsDir([
      user('build the to-do list'),
      tool('Write', { file_path: 'C:\\x.html' }),
      user('now work on the see test results and changes on the phone thing'),
      user([{ type: 'tool_result', content: 'ok' }]),
      user('<system-reminder>ignore me</system-reminder>'),
      tool('Write', { file_path: 'C:\\dev\\NOVI\\plugins\\changes\\tests.js' }),
    ]);
    const [s] = activeSessions({ dir });
    expect(s).toMatchObject({ folder: 'C:\\dev\\NOVI', asked: 'now work on the see test results and changes on the phone thing', doing: 'writing tests.js' });
    // only the work since that last request counts (x.html was for the one before)
    expect(activityLine(s, 'NOVI')).toBe('In NOVI, Claude is writing tests.js. You asked: "now work on the see test results and changes on the phone thing".');
  });

  it('old sessions and helper (sidechain) lines do not count', () => {
    expect(activeSessions({ dir: sessionsDir([user('old job')], { ageMs: 60 * 60_000 }) })).toEqual([]);
    const dir = sessionsDir([user('real ask'), { ...tool('Bash', { command: 'npm test', description: 'Run the tests' }) }, { ...tool('Read', { file_path: 'a.js' }), isSidechain: true }]);
    expect(activeSessions({ dir })[0].doing).toBe('running a command: Run the tests');
  });

  it('long requests are cut short', () => {
    const [s] = activeSessions({ dir: sessionsDir([user(`fix ${'x '.repeat(200)}`)]) });
    expect(s.asked.length).toBeLessThanOrEqual(121);
    expect(s.asked.endsWith('…')).toBe(true);
  });
});

describe('"what is Claude working on" by voice (no AI)', () => {
  it('takes the ways it is said', () => {
    for (const t of ['What is Claude working on?', "what's claude doing", 'is Claude working on something', 'what is claude code doing right now', 'claude kya kar raha hai']) {
      expect(claudeActivityCommand(t)).toEqual({ tool: 'claude_activity', args: {} });
    }
  });
  it('leaves other Claude requests alone', () => {
    for (const t of ['tell Claude to add dark mode', 'open Claude', 'what is the progress', 'what is claude']) expect(claudeActivityCommand(t)).toBeNull();
  });
});

// User, 2026-10-29 (screenshot: "Claude Code is currently working on the novi project, writing a reply"):
// "it is too generic … what it is doing at the moment … working on login page or debugging or updating
// the ui". Now: the step it is on (the Claude app's plan, or TodoWrite in a terminal), the files it is
// changing, the kind of work, and what you asked for.
describe('what Claude is doing, specifically', () => {
  const result = (text) => ({ type: 'user', cwd: 'C:/dev/NOVI', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
  const plan = (input) => tool('mcp__ccd_turn__update_plan', input);

  it('the Claude app\'s plan: the step it is on, the file, and your request (system notes stripped)', () => {
    const dir = sessionsDir([
      user('<system-reminder>files changed</system-reminder>\nit is too generic, I want the specific thing'),
      plan({ items: [{ content: 'Read how it works', status: 'in_progress' }, { content: 'Write the tests', status: 'pending' }, { content: 'Build the richer description', status: 'pending' }, { content: 'Check live', status: 'pending' }] }),
      plan({ advance: true }),
      plan({ advance: true }),
      tool('Edit', { file_path: 'C:/dev/NOVI/plugins/claude-link/activity.js' }),
    ]);
    const [s] = activeSessions({ dir });
    expect(s).toMatchObject({ step: { n: 3, of: 4, title: 'Build the richer description' }, asked: 'it is too generic, I want the specific thing' });
    expect(activityLine(s, 'NOVI')).toBe('In NOVI, Claude is on step 3 of 4, "Build the richer description": editing activity.js. You asked: "it is too generic, I want the specific thing".');
  });

  it('a terminal session\'s TodoWrite step, in its own words', () => {
    const dir = sessionsDir([
      user('fix the login'),
      tool('TodoWrite', { todos: [{ content: 'Find the bug', status: 'completed', activeForm: 'Finding the bug' }, { content: 'Fix the login redirect', status: 'in_progress', activeForm: 'Fixing the login redirect' }, { content: 'Test it', status: 'pending', activeForm: 'Testing it' }] }),
      tool('Edit', { file_path: 'C:/dev/Portfolio/login.html' }),
    ]);
    expect(activityLine(activeSessions({ dir })[0], 'Portfolio')).toBe('In Portfolio, Claude is fixing the login redirect (step 2 of 3): editing login.html. You asked: "fix the login".');
  });

  it('no plan: the kind of work from what it touches — UI, tests, debugging failing tests', () => {
    const ui = sessionsDir([user('make it nicer'), tool('Edit', { file_path: 'C:/p/src/Header.jsx' }), tool('Edit', { file_path: 'C:/p/src/styles.css' })]);
    expect(activityLine(activeSessions({ dir: ui })[0], 'P')).toBe('In P, Claude is working on the UI: editing styles.css and Header.jsx. You asked: "make it nicer".');
    const dbg = sessionsDir([
      user('why does it crash'),
      tool('Bash', { command: 'npx vitest run', description: 'Run the tests' }),
      result('FAIL tests/a.test.js > adds\nAssertionError: expected 1 to be 2'),
      tool('Edit', { file_path: 'C:/p/src/math.js' }),
    ]);
    expect(activeSessions({ dir: dbg })[0].kind).toBe('debugging failing tests');
    const tests = sessionsDir([user('add tests'), tool('Write', { file_path: 'C:/p/tests/math.test.js' })]);
    expect(activeSessions({ dir: tests })[0].kind).toBe('writing tests');
  });

  it('"what is Claude doing rn" goes straight to it', () => {
    expect(claudeActivityCommand('What is claude doing rn?')).toEqual({ tool: 'claude_activity', args: {} });
    expect(claudeActivityCommand('what is claude doing at the moment')).toEqual({ tool: 'claude_activity', args: {} });
  });
});
