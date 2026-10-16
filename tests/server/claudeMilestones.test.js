import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskManager } from '../../server/claude/taskManager.js';
import { ClaudeSession } from '../../server/claude/session.js';
import { Memory } from '../../server/memory.js';
import { ApprovalQueue } from '../../server/permissions.js';

const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const until = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => (fn() ? resolve() : Date.now() - started > ms ? reject(new Error('timeout')) : setTimeout(tick, 10));
  tick();
});
let memory;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ms-'));
  memory = new Memory(path.join(dir, 'memory.json'));
  memory.rememberProject('portfolio', fs.mkdtempSync(path.join(dir, 'portfolio ')));
});
function setup(opts) {
  const tm = new TaskManager({ memory, approvals: new ApprovalQueue(), narratorIntervalMs: 10_000, ...opts, createSession: (o) => new ClaudeSession({ command: process.execPath, argsPrefix: [fake], ...o }) });
  const spoken = [];
  tm.on('speak', (t) => spoken.push(t));
  return { tm, spoken };
}

describe('spoken updates while Claude works', () => {
  it('says the plan, then each finished step, then the end', async () => {
    const { tm, spoken } = setup({ milestoneGapMs: 0 });
    tm.start('portfolio', 'PLAN a portfolio site');
    await until(() => tm.status().status === 'done');
    expect(spoken.filter((s) => !s.startsWith('Claude finished.'))).toEqual([
      "Claude made a plan of 3 steps. I'll tell you as each one is done.",
      'Claude finished step 1 of 3: Write the homepage.',
      'Claude finished step 2 of 3: Add the contact form.',
    ]);
    expect(spoken.at(-1)).toBe('Claude finished. Built the site.');
    await tm.shutdown();
  });

  it('never talks more often than the gap allows (the end still comes)', async () => {
    const { tm, spoken } = setup({ milestoneGapMs: 60_000 });
    tm.start('portfolio', 'PLAN');
    await until(() => tm.status().status === 'done');
    expect(spoken.filter((s) => s.startsWith('Claude finished step'))).toEqual([]);
    expect(spoken.at(-1)).toBe('Claude finished. Built the site.');
    await tm.shutdown();
  });

  it('a quiet stretch gets a "still working" line (at most 3 in a row)', async () => {
    const { tm, spoken } = setup({ milestoneGapMs: 0, stillWorkingMs: 40 });
    tm.start('portfolio', 'PLANWAIT');
    await new Promise((r) => setTimeout(r, 400));
    expect(spoken.filter((s) => s === 'Claude is still on step 1 of 3: Writing the homepage.')).toHaveLength(3);
    await tm.stop();
    const after = spoken.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(spoken.length).toBe(after);
    await tm.shutdown();
  });
});
