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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-q-'));
  memory = new Memory(path.join(dir, 'memory.json'));
  memory.rememberProject('portfolio', fs.mkdtempSync(path.join(dir, 'portfolio ')));
});

function setup({ onAsk = null, questionReminderMs } = {}) {
  const approvals = new ApprovalQueue();
  const asked = [];
  approvals.on('added', (a) => { asked.push(a); onAsk?.(a, approvals); });
  const tm = new TaskManager({
    memory, approvals, narratorIntervalMs: 10, ...(questionReminderMs ? { questionReminderMs } : {}),
    createSession: (opts) => new ClaudeSession({ command: process.execPath, argsPrefix: [fake], ...opts }),
  });
  const spoken = [];
  tm.on('speak', (t) => spoken.push(t));
  return { tm, approvals, asked, spoken };
}

describe("TaskManager: Claude's questions", () => {
  it('asks each question in turn and sends the answers back', async () => {
    const answers = ['Dark', 'No'];
    const { tm, asked, spoken } = setup({ onAsk: (a, q) => setTimeout(() => q.resolve(a.id, true, 'voice', null, { answer: answers[asked.length - 1] }), 5) });
    tm.start('portfolio', 'ASK about the theme');
    await until(() => tm.status().status === 'done');
    expect(asked.map((a) => a.question?.text)).toEqual(['Which color theme?', 'Add a contact form?']);
    expect(asked[0]).toMatchObject({ title: 'Claude asks: Which color theme?', prompt: 'Claude asks: Which color theme? One, Dark. Two, Light.', source: 'claude' });
    expect(spoken.at(-1)).toContain('Answers: {"Which color theme?":"Dark","Add a contact form?":"No"}');
    await tm.shutdown();
  });

  it('a skipped question tells Claude to choose', async () => {
    const { tm, spoken } = setup({ onAsk: (a, q) => setTimeout(() => q.resolve(a.id, false, 'voice'), 5) });
    tm.start('portfolio', 'ASK');
    await until(() => tm.status().status === 'done');
    expect(spoken.at(-1)).toContain('"Which color theme?":"The user skipped this question; choose sensibly and say what you chose."');
    await tm.shutdown();
  });

  it('reminds once while a question waits', async () => {
    const { tm, approvals, spoken } = setup({ questionReminderMs: 50 });
    tm.start('portfolio', 'ASK');
    await until(() => approvals.waitingQuestion());
    await new Promise((r) => setTimeout(r, 250));
    expect(spoken.filter((s) => s === 'Claude is still waiting: Which color theme?')).toHaveLength(1);
    await tm.stop();
    await tm.shutdown();
  });

  it('stopping the task skips the open question', async () => {
    const { tm, approvals } = setup();
    tm.start('portfolio', 'ASK');
    await until(() => approvals.waitingQuestion());
    await tm.stop();
    expect(approvals.pending()).toEqual([]);
    await tm.shutdown();
  });
});
