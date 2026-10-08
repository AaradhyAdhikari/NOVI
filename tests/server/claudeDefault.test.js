import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNovi } from '../../server/app.js';

function make(coder, claudeExists) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-coder-'));
  const claudeCommand = path.join(dataDir, 'claude.exe');
  if (claudeExists) fs.writeFileSync(claudeCommand, '');
  return createNovi({ dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand, coder }, {
    agent: { handle: async () => '' }, router: { status: () => [] }, transcribe: async () => '',
    cipher: { protect: async (v) => v, unprotect: async (v) => v },
  });
}

describe('default coder', () => {
  it('is Claude Code when it is installed', () => {
    expect(make('auto', true).tasks.agentName).toBe('Claude');
  });
  it('falls back to the free Novi Coder when Claude Code is missing or Novi Coder was chosen', () => {
    expect(make('auto', false).tasks.agentName).toBe('Novi Coder');
    expect(make('free', true).tasks.agentName).toBe('Novi Coder');
    expect(make('claude', false).tasks.agentName).toBe('Claude');
  });
});

describe('watching a Claude task from the laptop', () => {
  async function wired() {
    const { EventEmitter } = await import('node:events');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-watchapp-'));
    const calls = [];
    const tasks = Object.assign(new EventEmitter(), {
      task: { id: 't1', project: 'novi', path: 'C:\\novi', instruction: 'add dark mode', agentName: 'Claude' },
      status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {},
      takeOver: async () => ({ project: 'novi', path: 'C:\\novi', sessionId: 's1' }),
    });
    const watchWindows = {
      append: (id, text) => calls.push(['append', id, text]),
      openWatch: (t) => calls.push(['watch', t.taskId, t.project, t.path, t.instruction]),
      openTakeOver: (h) => calls.push(['takeOver', h.sessionId]),
    };
    const novi = createNovi({ dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand: process.execPath, coder: 'auto' }, {
      tasks, watchWindows, agent: { handle: async () => '' }, router: { status: () => [] }, transcribe: async () => '',
      cipher: { protect: async (v) => v, unprotect: async (v) => v },
    });
    return { novi, tasks, calls };
  }

  it('opens one watch window when a Claude task starts and logs its progress there', async () => {
    const { tasks, calls } = await wired();
    tasks.emit('task', { active: true, id: 't1', agent: 'Claude', status: 'running', project: 'novi' });
    tasks.emit('task', { active: true, id: 't1', agent: 'Claude', status: 'running', project: 'novi' });
    tasks.emit('feed', { taskId: 't1', text: 'Editing App.jsx' });
    tasks.emit('task', { active: true, id: 't1', agent: 'Claude', status: 'done', project: 'novi', summary: 'Dark mode added.' });
    expect(calls[0]).toEqual(['watch', 't1', 'novi', 'C:\\novi', 'add dark mode']);
    expect(calls.filter((c) => c[0] === 'watch')).toHaveLength(1);
    expect(calls).toContainEqual(['append', 't1', 'Editing App.jsx']);
    expect(calls.at(-1)[2]).toMatch(/Done: Dark mode added\..*take over/);
  });

  it('a Novi Coder task opens no window', async () => {
    const { tasks, calls } = await wired();
    tasks.emit('task', { active: true, id: 't2', agent: 'Novi Coder', status: 'running', project: 'novi' });
    expect(calls).toEqual([]);
  });

  it('"take over" stops the run and opens interactive Claude Code', async () => {
    const { novi, calls } = await wired();
    const out = await novi.tools.get('code_take_over').run({});
    expect(out.tookOver).toBe(true);
    expect(calls).toContainEqual(['takeOver', 's1']);
  });
});
