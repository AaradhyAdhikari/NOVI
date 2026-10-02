import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskManager, permissionTitle } from '../../server/claude/taskManager.js';
import { ClaudeSession } from '../../server/claude/session.js';
import { Memory } from '../../server/memory.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { UserFacingError } from '../../server/errors.js';

const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));

let memory;
let approvals;
let asked;
let spawned;

function makeManager({ answer = true } = {}) {
  approvals = new ApprovalQueue();
  asked = [];
  approvals.on('added', (a) => { asked.push(a); approvals.resolve(a.id, answer); });
  spawned = [];
  const tm = new TaskManager({
    memory,
    approvals,
    narratorIntervalMs: 10,
    createSession: (opts) => {
      spawned.push(opts.resumeSessionId || null);
      return new ClaudeSession({ command: process.execPath, argsPrefix: [fake], ...opts });
    },
  });
  const spoken = [];
  const fed = [];
  tm.on('speak', (t) => spoken.push(t));
  tm.on('feed', (f) => fed.push(f.text));
  return { tm, spoken, fed };
}

const until = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => (fn() ? resolve() : Date.now() - started > ms ? reject(new Error('timeout')) : setTimeout(tick, 10));
  tick();
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tm-'));
  memory = new Memory(path.join(dir, 'memory.json'));
  memory.rememberProject('portfolio', fs.mkdtempSync(path.join(dir, 'portfolio ')));
});

describe('TaskManager', () => {
  it('rejects unknown projects with a user-facing error', () => {
    const { tm } = makeManager();
    expect(() => tm.start('nope', 'x')).toThrow(UserFacingError);
  });

  it('runs a task end to end with approval, narration and persistence', async () => {
    const { tm, spoken, fed } = makeManager();
    tm.start('portfolio', 'add login');
    expect(tm.status()).toMatchObject({ active: true, project: 'portfolio', status: 'running' });
    await until(() => tm.status().status === 'done');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tier: 'medium', source: 'claude', title: 'Claude wants to create/overwrite src/login.js' });
    expect(fed).toContain('Reading app.js');
    expect(spoken.at(-1)).toBe('Claude finished. Finished: add login.');
    expect(memory.lastTask()).toMatchObject({ project: 'portfolio', status: 'done', sessionId: 'fake-session-1' });
    await tm.shutdown();
  });

  it('skips approval for edits when allowEdits is on', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'add login');
    tm.setAllowEdits(true);
    await until(() => tm.status().status === 'done');
    expect(asked).toHaveLength(0);
    await tm.shutdown();
  });

  it('refuses a second task while one is running', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'HANG');
    expect(() => tm.start('portfolio', 'other')).toThrow(/already working/);
    await tm.shutdown();
  });

  it('resumes the last session after a restart', async () => {
    const first = makeManager();
    first.tm.start('portfolio', 'add login');
    await until(() => first.tm.status().status === 'done');
    await first.tm.shutdown();

    const second = makeManager();
    second.tm.send('now add tests');
    await until(() => second.tm.status().status === 'done');
    expect(spawned).toEqual(['fake-session-1']);
    await second.tm.shutdown();
  });

  it('stop() marks the task stopped without an "exited unexpectedly" message', async () => {
    const { tm, spoken } = makeManager();
    tm.start('portfolio', 'HANG');
    await new Promise((r) => setTimeout(r, 200));
    expect(await tm.stop()).toBe(true);
    expect(tm.status().status).toBe('stopped');
    expect(spoken.join(' ')).not.toMatch(/unexpectedly/);
    expect(await tm.stop()).toBe(false);
  });

  it('shutdown() leaves no live session', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'HANG');
    await tm.shutdown();
    expect(tm.session.exited).toBe(true);
  });

  it('send() with no task at all is a user-facing error', () => {
    const fresh = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tm2-')), 'm.json'));
    const tm = new TaskManager({ memory: fresh, approvals: new ApprovalQueue(), createSession: () => { throw new Error('no'); } });
    expect(() => tm.send('x')).toThrow(UserFacingError);
  });
});

describe('permissionTitle', () => {
  it('describes commands and edits', () => {
    expect(permissionTitle('Bash', { command: 'npm i' })).toBe('Claude wants to run: npm i');
    expect(permissionTitle('Edit', { file_path: 'a.js' })).toBe('Claude wants to edit a.js');
    expect(permissionTitle('WebFetch', {})).toBe('Claude wants to use WebFetch');
  });
});
