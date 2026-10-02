import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeSession, claudeArgs } from '../../server/claude/session.js';

const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'novi スペース dir '));

function open({ allow = true, resumeSessionId } = {}) {
  const asked = [];
  const events = [];
  const session = new ClaudeSession({
    command: process.execPath,
    argsPrefix: [fake],
    cwd,
    resumeSessionId,
    onPermission: async (req) => { asked.push(req); return { allow }; },
  });
  session.on('event', (e) => events.push(e));
  const waitFor = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - started > ms) return reject(new Error(`timeout; got ${JSON.stringify(events.map((e) => e.kind))}`));
      setTimeout(tick, 10);
    };
    tick();
  });
  return { session, asked, events, waitFor };
}

describe('claudeArgs', () => {
  it('includes the verified headless flags and resume', () => {
    const args = claudeArgs({ resumeSessionId: 's9' });
    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio']));
    expect(args.slice(-2)).toEqual(['--resume', 's9']);
  });
});

describe('ClaudeSession (against fake CLI)', () => {
  it('runs a turn in a folder with spaces/non-ASCII, asks permission, reports result', async () => {
    const { session, asked, events, waitFor } = open();
    session.send('add login');
    const result = await waitFor((e) => e.kind === 'result');
    expect(session.sessionId).toBe('fake-session-1');
    expect(asked).toEqual([{ toolName: 'Write', input: { file_path: 'src/login.js', content: 'x' }, description: 'login.js' }]);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['init', 'tool_use', 'tool_result', 'text']));
    expect(result).toMatchObject({ isError: false, text: 'Finished: add login. All good.', numTurns: 1 });
    session.close();
    await waitFor((e) => e.kind === 'exit');
  });

  it('passes denials back to Claude', async () => {
    const { session, events, waitFor } = open({ allow: false });
    session.send('add login');
    const result = await waitFor((e) => e.kind === 'result');
    expect(result.text).toBe('Could not write file');
    expect(events.find((e) => e.kind === 'tool_result' && e.id === 'tu-write').isError).toBe(true);
    session.close();
  });

  it('keeps one session across follow-ups', async () => {
    const { session, waitFor } = open();
    session.send('first');
    await waitFor((e) => e.kind === 'result' && e.numTurns === 1);
    session.send('second');
    const second = await waitFor((e) => e.kind === 'result' && e.numTurns === 2);
    expect(second.sessionId).toBe('fake-session-1');
    session.close();
  });

  it('resumes a previous session id', async () => {
    const { session, waitFor } = open({ resumeSessionId: 'old-session' });
    await waitFor((e) => e.kind === 'init');
    expect(session.sessionId).toBe('old-session');
    session.close();
  });

  it('stop() interrupts a hanging turn and the process exits', async () => {
    const { session, waitFor } = open();
    session.send('HANG forever');
    await waitFor((e) => e.kind === 'init');
    await session.stop({ graceMs: 3000 });
    await waitFor((e) => e.kind === 'exit');
    expect(session.exited).toBe(true);
  });

  it('reports a missing executable as an exit with an error', async () => {
    const events = [];
    const session = new ClaudeSession({ command: path.join(cwd, 'no-such-claude.exe'), cwd, onPermission: async () => ({ allow: false }) });
    session.on('event', (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 500));
    expect(events.find((e) => e.kind === 'exit')?.error).toBeTruthy();
  });
});
