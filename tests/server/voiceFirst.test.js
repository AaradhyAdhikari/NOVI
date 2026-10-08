import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quickCommand, Agent } from '../../server/brain/agent.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { PluginHost } from '../../server/plugins/host.js';
import { wrapRegistryAsPlugin } from '../../server/plugins/builtin.js';
import { createNoviTools } from '../../server/tools/noviTools.js';
import { TaskManager } from '../../server/claude/taskManager.js';
import { Memory } from '../../server/memory.js';

describe('voice phrases', () => {
  it('understands yes / no / use X instead', () => {
    for (const t of ['yes', 'Yes, start.', 'sure', 'go ahead', 'yes please', 'start it']) expect(quickCommand(t), t).toBe('approve');
    for (const t of ['no', 'No thanks', 'nope', "don't"]) expect(quickCommand(t), t).toBe('deny');
  });

  it('understands your everyday Hinglish / Hindi / Marathi yes, no and cancel', () => {
    for (const t of ['go for it', 'Approved.', 'include kar', 'karle update', 'karle', 'kar do', 'haan', 'haan kar do', 'theek hai', 'chalega', 'हाँ', 'हां', 'कर दो', 'ठीक है', 'हो', 'चालेल']) expect(quickCommand(t), t).toBe('approve');
    for (const t of ['nahi', 'nahin', 'mat kar', 'rehne de', 'nako', 'नहीं', 'मत करो', 'नको']) expect(quickCommand(t), t).toBe('deny');
    for (const t of ['cancel kar', 'cancel it', 'Cancel karo.', 'ruk ja', 'band kar', 'रुक जा', 'कैंसल कर']) expect(quickCommand(t), t).toBe('stop');
    // Longer sentences still go to the brain.
    for (const t of ['haan but use cursor', 'kar do weather check', 'nahi pata']) expect(quickCommand(t), t).toBeNull();
    for (const t of ['use Claude instead', 'No, use Claude.', 'use claude', 'with Claude', 'Claude instead']) expect(quickCommand(t), t).toBe('choose:claude');
    for (const t of ['use Novi Coder', 'use the free one', 'novi coder instead']) expect(quickCommand(t), t).toBe('choose:novi-coder');
    expect(quickCommand('use claude to write a poem about cats')).toBeNull();
  });
});

describe('approval choices', () => {
  it('decide() reports the chosen option; request() still resolves to a boolean', async () => {
    const q = new ApprovalQueue();
    const resolved = [];
    q.on('resolved', (r) => resolved.push(r));
    const d = q.decide({ title: 'Start?', tier: 'medium', source: 'novi', prompt: 'Shall I start?', choices: [{ id: 'claude', label: 'Use Claude' }] });
    const a = q.pending()[0];
    expect(a).toMatchObject({ prompt: 'Shall I start?', choices: [{ id: 'claude', label: 'Use Claude' }] });
    q.resolve(a.id, true, 'voice', 'claude');
    await expect(d).resolves.toEqual({ allow: true, choice: 'claude' });
    expect(resolved[0]).toEqual({ id: a.id, allow: true, by: 'voice', choice: 'claude' });
    const r = q.request({ title: 'x', tier: 'medium', source: 'novi' });
    q.resolve(q.pending()[0].id, true);
    await expect(r).resolves.toBe(true);
  });

  it('ignores unknown choices', async () => {
    const q = new ApprovalQueue();
    const d = q.decide({ title: 'x', tier: 'medium', source: 'novi', choices: [{ id: 'claude', label: 'C' }] });
    q.resolve(q.pending()[0].id, true, 'screen', 'hacker');
    await expect(d).resolves.toEqual({ allow: true, choice: null });
  });
});

function memoryWithProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-vf-'));
  const memory = new Memory(path.join(dir, 'memory.json'));
  memory.rememberProject('playground', dir);
  return memory;
}

describe('coding task dispatch', () => {
  function setup({ alternativeAvailable = true, steps }) {
    const started = [];
    const tasks = { start: (p, i, opts) => { started.push([p, i, opts]); return { active: true }; }, send() {}, status: () => ({ active: false }), stop: async () => false, setAllowEdits() {} };
    const plugins = new PluginHost({ logger: { warn() {} } });
    plugins.register(wrapRegistryAsPlugin({ id: 'coding', name: 'Coding', registry: createNoviTools({ memory: memoryWithProject(), tasks, alternativeAvailable }) }));
    const approvals = new ApprovalQueue();
    const added = [];
    const calls = [];
    const router = { calls, chat: async (req) => { calls.push(structuredClone(req)); return steps[calls.length - 1]; } };
    const agent = new Agent({ router, tools: plugins, approvals, memory: { listProjects: () => [] }, tasks });
    approvals.on('added', (a) => added.push(a));
    return { agent, plugins, approvals, added, started };
  }
  const startCall = (args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'code_start_task', arguments: JSON.stringify(args) } }] }, provider: 'groq', model: 'm' });
  const reply = (content) => ({ message: { role: 'assistant', content }, provider: 'groq', model: 'm' });

  it('announces Novi Coder, offers Claude, and starts with Claude when the user says "use Claude instead"', async () => {
    const { agent, added, started } = setup({ steps: [startCall({ project: 'playground', instruction: 'add login' }), reply('Starting with Claude.')] });
    const turn = agent.handle('add login to playground');
    for (let i = 0; i < 50 && !added.length; i++) await new Promise((r) => setTimeout(r, 2));
    expect(added[0].title).toBe('Start Novi Coder (free, Groq) on playground: "add login"');
    expect(added[0].prompt).toBe("I'll use Novi Coder, free on Groq, on playground: add login. Shall I start? Say yes, no, or use Claude instead.");
    expect(added[0].choices).toEqual([{ id: 'claude', label: 'Use Claude' }]);
    expect(await agent.handle('use Claude instead')).toBe('Okay, using Claude Code.');
    await turn;
    expect(started).toEqual([['playground', 'add login', { agent: 'claude' }]]);
  });

  it('plain "yes" starts Novi Coder', async () => {
    const { agent, added, started } = setup({ steps: [startCall({ project: 'playground', instruction: 'add login' }), reply('Started.')] });
    const turn = agent.handle('add login');
    for (let i = 0; i < 50 && !added.length; i++) await new Promise((r) => setTimeout(r, 2));
    expect(await agent.handle('yes')).toBe('Approved.');
    await turn;
    expect(started).toEqual([['playground', 'add login', { agent: undefined }]]);
  });

  it('does not offer Claude when it is not installed, and ignores a model trying to pick it', async () => {
    const { agent, added, started, approvals } = setup({ alternativeAvailable: false, steps: [startCall({ project: 'playground', instruction: 'x', $agent: 'claude' }), reply('ok')] });
    const turn = agent.handle('x');
    for (let i = 0; i < 50 && !added.length; i++) await new Promise((r) => setTimeout(r, 2));
    expect(added[0].choices).toBeUndefined();
    expect(added[0].prompt).toBe("I'll use Novi Coder, free on Groq, on playground: x. Shall I start? Say yes or no.");
    approvals.resolve(added[0].id, true, 'screen');
    await turn;
    expect(started).toEqual([['playground', 'x', { agent: undefined }]]);
  });
});

describe('TaskManager picks the coder per task', () => {
  it('passes the chosen agent to the session and names it', () => {
    const opened = [];
    const fakeSession = () => ({ on() {}, send() {}, close() {}, exited: false });
    const tm = new TaskManager({
      memory: memoryWithProject(),
      approvals: new ApprovalQueue(),
      agentName: 'Novi Coder',
      agentLabels: { 'novi-coder': 'Novi Coder', claude: 'Claude' },
      createSession: (opts) => { opened.push(opts.agent); return fakeSession(); },
    });
    tm.start('playground', 'add login', { agent: 'claude' });
    expect(opened).toEqual(['claude']);
    expect(tm.status().agent).toBe('Claude');
  });
});

describe('dispatch prompt wording', () => {
  it('does not double the full stop when the instruction ends with one', () => {
    const tools = createNoviTools({ memory: memoryWithProject(), tasks: {}, alternativeAvailable: true });
    expect(tools.get('code_start_task').prompt({ project: 'playground', instruction: 'Create notes.txt.' }))
      .toBe("I'll use Novi Coder, free on Groq, on playground: Create notes.txt. Shall I start? Say yes, no, or use Claude instead.");
  });
});
