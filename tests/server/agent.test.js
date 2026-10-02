import { describe, it, expect } from 'vitest';
import { Agent, quickCommand, describeStatus } from '../../server/brain/agent.js';
import { AllProvidersUnavailableError } from '../../server/brain/router.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import { UserFacingError } from '../../server/errors.js';

function scriptedRouter(steps) {
  const calls = [];
  return {
    calls,
    chat: async (req) => {
      calls.push(structuredClone(req));
      const step = steps[calls.length - 1];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const toolCall = (name, args, id = 'c1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, extra_content: { google: { thought_signature: 'sig' } } });

function setup(steps, { autoAnswer } = {}) {
  const router = scriptedRouter(steps);
  const approvals = new ApprovalQueue();
  if (autoAnswer !== undefined) approvals.on('added', (a) => approvals.resolve(a.id, autoAnswer));
  const ran = [];
  const tools = new ToolRegistry()
    .add({ name: 'code_start_task', description: 'start', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: (a) => `Start on ${a.project}`, run: async (a) => { ran.push(a); return { started: true, note: 'Claude is working on it.' }; } })
    .add({ name: 'code_status', description: 'status', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 's', run: async () => ({ active: false }) })
    .add({ name: 'fails', description: 'f', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'f', run: async () => { throw new UserFacingError('I do not know that project.'); } });
  const tasks = { status: () => ({ active: false }), stop: async () => true };
  const memory = { listProjects: () => [{ name: 'portfolio', path: 'C:\\p' }] };
  const agent = new Agent({ router, tools, approvals, memory, tasks });
  return { agent, router, approvals, ran };
}

const reply = (content, provider = 'groq') => ({ message: { role: 'assistant', content }, provider, model: 'm' });

describe('quickCommand', () => {
  it('recognises stop, approve, deny, status', () => {
    expect(quickCommand('Stop.')).toBe('stop');
    expect(quickCommand('yes')).toBe('approve');
    expect(quickCommand('No!')).toBe('deny');
    expect(quickCommand("What's Claude doing?")).toBe('status');
    expect(quickCommand('stop using tabs in my code')).toBeNull();
  });
});

describe('Agent', () => {
  it('returns a plain reply and keeps it in history', async () => {
    const { agent, router } = setup([reply('Hi there.'), reply('Still here.')]);
    expect(await agent.handle('hello')).toBe('Hi there.');
    await agent.handle('again');
    const msgs = router.calls[1].messages;
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('portfolio (C:\\p)');
    expect(msgs.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('asks approval for medium tools, runs them, and keeps the turn on one provider with the raw message', async () => {
    const assistant = { role: 'assistant', content: null, tool_calls: [toolCall('code_start_task', { project: 'portfolio', instruction: 'add login' })] };
    const { agent, router, ran } = setup([{ message: assistant, provider: 'gemini', model: 'g' }, reply('On it.', 'gemini')], { autoAnswer: true });
    expect(await agent.handle('ask claude to add login to portfolio')).toBe('On it.');
    expect(ran).toEqual([{ project: 'portfolio', instruction: 'add login' }]);
    const second = router.calls[1];
    expect(second.only).toBe('gemini');
    expect(second.messages.at(-2)).toEqual(assistant);
    expect(second.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ started: true, note: 'Claude is working on it.' }) });
  });

  it('feeds denial back to the model instead of running the tool', async () => {
    const assistant = { role: 'assistant', content: null, tool_calls: [toolCall('code_start_task', { project: 'portfolio' })] };
    const { agent, router, ran } = setup([{ message: assistant, provider: 'groq', model: 'm' }, reply('Okay, I will not.')], { autoAnswer: false });
    expect(await agent.handle('start it')).toBe('Okay, I will not.');
    expect(ran).toEqual([]);
    expect(JSON.parse(router.calls[1].messages.at(-1).content)).toEqual({ error: 'The user declined this action.' });
  });

  it('feeds back invalid JSON arguments and tool errors', async () => {
    const assistant = { role: 'assistant', content: null, tool_calls: [toolCall('code_status', '{bad', 'a'), toolCall('fails', {}, 'b'), toolCall('nope', {}, 'c')] };
    const { agent, router } = setup([{ message: assistant, provider: 'groq', model: 'm' }, reply('Sorted.')]);
    await agent.handle('x');
    const toolMsgs = router.calls[1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    expect(toolMsgs).toEqual([{ error: 'Arguments were not valid JSON' }, { error: 'I do not know that project.' }, { error: 'Unknown tool nope' }]);
  });

  it('handles stop locally without calling the router', async () => {
    const { agent, router } = setup([]);
    expect(await agent.handle('stop')).toBe('Okay, I stopped the coding task.');
    expect(router.calls).toHaveLength(0);
  });

  it('voice yes approves the latest medium item but never a high one', async () => {
    const { agent, approvals } = setup([]);
    const medium = approvals.request({ title: 'edit a.js', tier: 'medium', source: 'claude' });
    expect(await agent.handle('yes')).toBe('Approved.');
    await expect(medium).resolves.toBe(true);

    approvals.request({ title: 'git push', tier: 'high', source: 'claude' });
    expect(await agent.handle('yes')).toBe('That one is high risk, so please confirm it on screen.');
    expect(approvals.pending()).toHaveLength(1);
  });

  it('says when providers are busy', async () => {
    const { agent } = setup([new AllProvidersUnavailableError(12_300)]);
    expect(await agent.handle('hello')).toBe('My AI providers are busy right now. Try again in about 13 seconds.');
  });
});

describe('systemPrompt', () => {
  it('tells the brain about laptop actions and positions in YouTube results', async () => {
    const { systemPrompt } = await import('../../server/brain/agent.js');
    const p = systemPrompt({ projects: [], task: { active: false } });
    for (const name of ['open_website', 'play_youtube', 'youtube_search', 'open_app']) expect(p).toContain(name);
    expect(p).toMatch(/position/);
  });
});

describe('describeStatus', () => {
  it('summarises task states', () => {
    expect(describeStatus({ active: false })).toBe('No coding task is running right now.');
    expect(describeStatus({ active: true, agent: 'Novi Coder', status: 'running', project: 'site', recent: [] })).toBe('Novi Coder is working on site.');
    expect(describeStatus({ active: true, status: 'running', project: 'portfolio', recent: ['Reading a.js', 'Editing a.js'] }))
      .toBe('Claude is working on portfolio. Latest: Reading a.js, then Editing a.js.');
    expect(describeStatus({ active: true, status: 'done', project: 'portfolio', summary: 'Added login. Tests pass.', recent: [] }))
      .toBe('Claude finished the task on portfolio. Added login.');
  });
});
