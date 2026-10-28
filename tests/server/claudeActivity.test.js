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
    expect(activityLine(s, 'NOVI')).toBe('Claude Code is working on NOVI: "now work on the see test results and changes on the phone thing". Right now it is writing tests.js.');
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
