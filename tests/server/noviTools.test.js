import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNoviTools } from '../../server/tools/noviTools.js';
import { Memory } from '../../server/memory.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tools-'));
  const memory = new Memory(path.join(dir, 'm.json'));
  const calls = [];
  const tasks = {
    start: (p, i) => { calls.push(['start', p, i]); return { active: true, project: p, status: 'running' }; },
    send: (t) => { calls.push(['send', t]); return { active: true, status: 'running' }; },
    status: () => ({ active: false }),
    stop: async () => true,
    setAllowEdits: (v) => calls.push(['allowEdits', v]),
  };
  return { dir, memory, tasks, calls, tools: createNoviTools({ memory, tasks }) };
}

describe('createNoviTools', () => {
  it('exposes OpenAI-format schemas for all tools', () => {
    const { tools } = setup();
    const names = tools.schemas().map((s) => s.function.name);
    expect(names).toEqual(['list_projects', 'remember_project', 'forget_project', 'code_start_task', 'code_send_message', 'code_status', 'code_stop', 'code_allow_edits']);
    for (const s of tools.schemas()) {
      expect(s.type).toBe('function');
      expect(s.function.parameters.type).toBe('object');
    }
  });

  it('assigns tiers', () => {
    const { tools } = setup();
    expect(tools.get('list_projects').tier).toBe('low');
    expect(tools.get('code_start_task').tier).toBe('medium');
    expect(tools.get('remember_project').tier).toBe('medium');
    expect(tools.get('code_stop').tier).toBe('low');
  });

  it('remembers and lists projects', async () => {
    const { tools, dir } = setup();
    await tools.get('remember_project').run({ name: 'Site', path: dir });
    expect(await tools.get('list_projects').run({})).toEqual({ projects: [{ name: 'site', path: path.resolve(dir) }] });
  });

  it('starts tasks and sends follow-ups through the task manager', async () => {
    const { tools, calls } = setup();
    const out = await tools.get('code_start_task').run({ project: 'site', instruction: 'add login' });
    expect(out.started).toBe(true);
    await tools.get('code_send_message').run({ instruction: 'fix it' });
    expect(calls).toEqual([['start', 'site', 'add login'], ['send', 'fix it']]);
  });

  it('describes actions for approval prompts', () => {
    const { tools } = setup();
    expect(tools.get('code_start_task').describe({ project: 'site', instruction: 'add login' })).toBe('Start Novi Coder (free, Groq) on site: "add login"');
  });
});
