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

// User, 2026-10-18: reading out every step was irritating. The plan comes first as a card (plan
// first), steps stay on screen ("what's the progress" still answers), only the end is spoken.
describe('spoken updates while Claude works', () => {
  it('only the end is spoken; the plan and steps stay on the screen', async () => {
    const { tm, spoken } = setup({ milestoneGapMs: 0, stillWorkingMs: 40 });
    tm.start('portfolio', 'PLAN a portfolio site', { planFirst: false });
    await until(() => tm.status().status === 'done');
    expect(spoken).toEqual(['Claude finished. Built the site.']);
    expect(tm.status().plan).toHaveLength(3);
    await tm.shutdown();
  });

  it('no "still working" lines in a quiet stretch', async () => {
    const { tm, spoken } = setup({ milestoneGapMs: 0, stillWorkingMs: 40 });
    tm.start('portfolio', 'PLANWAIT', { planFirst: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(spoken).toEqual([]);
    await tm.shutdown();
  });
});
