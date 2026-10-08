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

describe('choosing the coder by voice', () => {
  function withCoder(coder) {
    const s = setup();
    const started = [];
    s.tasks.start = (p, i, opts) => { started.push(opts); return { active: true }; };
    return { ...s, started, tools: createNoviTools({ memory: s.memory, tasks: s.tasks, coder, alternativeAvailable: true }) };
  }

  it('the brain can pick the coder the user named; otherwise the default (Claude Code) is used', async () => {
    const { tools, started } = withCoder('claude');
    const start = tools.get('code_start_task');
    expect(start.parameters.properties.agent.enum).toEqual(['claude', 'novi-coder']);
    await start.run({ project: 'site', instruction: 'add login' });
    await start.run({ project: 'site', instruction: 'add login', agent: 'novi-coder' });
    await start.run({ project: 'site', instruction: 'add login', agent: 'cursor' }); // not a coder → default
    expect(started.map((o) => o?.agent)).toEqual([undefined, 'novi-coder', undefined]);
  });

  it('the spoken question names the coder that will run, and a card choice still wins', async () => {
    const { tools, started } = withCoder('claude');
    const start = tools.get('code_start_task');
    expect(start.prompt({ project: 'site', instruction: 'add login' })).toMatch(/^I'll use Claude Code/);
    expect(start.prompt({ project: 'site', instruction: 'add login', agent: 'novi-coder' })).toMatch(/^I'll use Novi Coder.*use Claude instead/);
    expect(start.describe({ project: 'site', instruction: 'x', agent: 'novi-coder' })).toMatch(/^Start Novi Coder/);
    expect(start.choices({ project: 'site', instruction: 'x', agent: 'novi-coder' })[0]).toMatchObject({ id: 'claude', params: { $agent: 'claude' } });
    await start.run({ project: 'site', instruction: 'x', agent: 'novi-coder', $agent: 'claude' });
    expect(started.at(-1).agent).toBe('claude');
  });
});

describe('Novi picks the coder by how hard the job is', () => {
  it('tells the brain: small edits → Novi Coder (free), bigger work → Claude Code, what the user says wins', () => {
    const s = setup();
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, coder: 'claude', alternativeAvailable: true });
    const agent = tools.get('code_start_task').parameters.properties.agent.description;
    expect(agent).toMatch(/named/i);
    expect(agent).toMatch(/novi-coder.*small|small.*novi-coder/i);
    expect(agent).toMatch(/claude.*(bigger|feature|bug)/i);
  });

  it('without Claude Code installed there is nothing to choose between', () => {
    const s = setup();
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, coder: 'novi-coder', alternativeAvailable: false });
    expect(tools.get('code_start_task').parameters.properties.agent).toBeUndefined();
  });
});

describe('code_take_over', () => {
  it('hands the task over to interactive Claude Code on the laptop', async () => {
    const s = setup();
    const opened = [];
    const tools = createNoviTools({ memory: s.memory, tasks: s.tasks, takeOver: async () => { opened.push('x'); return { project: 'novi' }; } });
    const t = tools.get('code_take_over');
    expect(t.tier).toBe('low');
    expect(t.description).toMatch(/take over/i);
    expect(await t.run({})).toEqual({ tookOver: true, project: 'novi', note: 'Opened Claude Code on novi with the same conversation. Over to you.' });
    expect(opened).toEqual(['x']);
  });

  it('is only offered when the laptop can open Claude Code', () => {
    const s = setup();
    expect(createNoviTools({ memory: s.memory, tasks: s.tasks }).get('code_take_over')).toBeFalsy();
  });
});
