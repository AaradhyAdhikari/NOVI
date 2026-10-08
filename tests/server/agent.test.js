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
    expect(p).toMatch(/read out the top 5/i);
  });
});

describe('Agent account features', () => {
  function build(steps, { tool, privateProviders } = {}) {
    const router = scriptedRouter(steps);
    const approvals = new ApprovalQueue();
    const requested = [];
    approvals.on('added', (a) => { requested.push(a); approvals.resolve(a.id, true); });
    const tools = new ToolRegistry().add(tool);
    const agent = new Agent({ router, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }), stop: async () => false }, privateProviders });
    return { agent, router, requested };
  }

  it('precheck can answer instead of asking for approval', async () => {
    const tool = { name: 'send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send', precheck: async () => ({ ask: ['a', 'b'], note: 'Which account?' }), run: async () => { throw new Error('must not run'); } };
    const { agent, router, requested } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('send', {})] }, provider: 'groq', model: 'm' }, reply('Which account?')], { tool });
    expect(await agent.handle('send it')).toBe('Which account?');
    expect(requested).toEqual([]);
    expect(JSON.parse(router.calls[1].messages.at(-1).content)).toEqual({ ask: ['a', 'b'], note: 'Which account?' });
  });

  it('puts the tool detail (e.g. the full email) in the approval', async () => {
    const tool = { name: 'send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send from college to sir', detail: (a) => a.body, run: async () => ({ sent: true }) };
    const { agent, requested } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('send', { body: 'Full email text' })] }, provider: 'groq', model: 'm' }, reply('Sent.')], { tool });
    await agent.handle('send it');
    expect(requested[0]).toMatchObject({ title: 'Send from college to sir', detail: 'Full email text' });
  });

  it('never passes sensitive results to a non-private provider', async () => {
    const tool = { name: 'mail', description: 'm', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'mail', run: async () => ({ sensitive: true, messages: ['secret'] }) };
    const { agent, router } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('mail', {})] }, provider: 'gemini', model: 'g' }], { tool });
    expect(await agent.handle('check my mail')).toBe("I can't read your mail right now — my private AI provider is busy. Try again in a minute.");
    expect(router.calls).toHaveLength(1);
  });

  it('continues on the private provider', async () => {
    const tool = { name: 'mail', description: 'm', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'mail', run: async () => ({ sensitive: true, messages: ['secret'] }) };
    const { agent, router } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('mail', {})] }, provider: 'groq', model: 'm' }, reply('One new email from Sir.')], { tool });
    expect(await agent.handle('check my mail')).toBe('One new email from Sir.');
    expect(router.calls[1].only).toBe('groq');
    expect(agent.history.map((m) => m.content)).toEqual(['check my mail', 'One new email from Sir.']);
  });

  it('mentions connected accounts and Gmail tools in the system prompt', async () => {
    const { systemPrompt } = await import('../../server/brain/agent.js');
    const p = systemPrompt({ projects: [], task: { active: false }, accounts: [{ provider: 'google', label: 'college', email: 'c@college.edu', isDefault: true }] });
    expect(p).toContain('gmail_search');
    expect(p).toContain('college (c@college.edu, default)');
    expect(systemPrompt({ projects: [], task: { active: false }, accounts: [{ provider: 'github', label: 'octo', email: 'octo' }] })).toContain('GitHub octo (octo)');
    expect(p).toMatch(/ask the user which account/i);
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

describe('plugin context in the prompt (long-term memory)', () => {
  function withContext(ctx, steps) {
    const router = scriptedRouter(steps);
    const ended = [];
    const tools = new ToolRegistry();
    tools.promptContext = async ({ prompt }) => ({ ...ctx, context: ctx.context ? `${ctx.context} [${prompt}]` : '' });
    tools.agentEnd = async (e) => { ended.push(e); };
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, privateProviders: ['groq'] });
    return { agent, router, ended };
  }

  it('adds plugin guidance and context to the system prompt', async () => {
    const { agent, router } = withContext({ system: 'Use memory_remember for lasting facts.', context: "Things you remember: Mom's birthday is 12 March.", sensitive: false }, [reply('12 March.')]);
    await agent.handle("When is Mom's birthday?");
    const system = router.calls[0].messages[0].content;
    expect(system).toContain('Use memory_remember for lasting facts.');
    expect(system).toContain("Mom's birthday is 12 March. [When is Mom's birthday?]");
    expect(router.calls[0].only).toBeUndefined();
  });

  it('keeps the turn on the private provider when the context is personal', async () => {
    const { agent, router } = withContext({ system: '', context: 'Things you remember: x', sensitive: true }, [reply('ok')]);
    await agent.handle('hi');
    expect(router.calls[0].only).toBe('groq');
  });

  it('reports each finished exchange to plugins', async () => {
    const { agent, ended } = withContext({ system: '', context: '', sensitive: false }, [reply('Hello!')]);
    await agent.handle('hi');
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toEqual([{ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }], success: true }]);
  });
});

describe('private turns wait briefly for the private provider', () => {
  function privateAgent(steps, sleep) {
    const router = scriptedRouter(steps);
    const tools = new ToolRegistry();
    tools.promptContext = async () => ({ system: '', context: 'Things you remember: x', sensitive: true });
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, privateProviders: ['groq'], sleep });
    return { agent, router };
  }

  it('waits for a short rate-limit and tries again instead of saying "busy"', async () => {
    const waits = [];
    const { agent, router } = privateAgent([new AllProvidersUnavailableError(9000), reply('12 March.')], async (ms) => { waits.push(ms); });
    expect(await agent.handle("When is mom's birthday?")).toBe('12 March.');
    expect(waits).toEqual([9000]);
    expect(router.calls.map((c) => c.only)).toEqual(['groq', 'groq']);
  });

  it('does not wait for long outages', async () => {
    const waits = [];
    const { agent } = privateAgent([new AllProvidersUnavailableError(60_000)], async (ms) => { waits.push(ms); });
    expect(await agent.handle('hi')).toMatch(/busy/);
    expect(waits).toEqual([]);
  });
});

describe('quick lane for simple questions', () => {
  const t = (name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } });
  function quickSetup() {
    const router = scriptedRouter([reply('ok'), reply('ok'), reply('ok')]);
    const tools = { schemas: () => [t('clock_now'), t('open_app'), t('memory_recall'), t('weather_get'), t('gmail_search')], get: () => null };
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    return { agent, router };
  }

  it('sends short, simple questions to the quick lane', async () => {
    const { agent, router } = quickSetup();
    await agent.handle('what time is it?');
    await agent.handle('tell me a joke');
    expect(router.calls.map((c) => c.purpose)).toEqual(['quick', 'quick']);
  });

  it('keeps the big model for anything that needs a real tool or a long answer', async () => {
    const { agent, router } = quickSetup();
    await agent.handle("what's the weather in Pune tomorrow?");
    await agent.handle('explain how binary search works step by step with an example and its time complexity in detail please');
    expect(router.calls.map((c) => c.purpose)).toEqual(['fast', 'fast']);
  });

  it('voice approvals pass the answering device through', async () => {
    const approvals = new ApprovalQueue();
    const seen = [];
    const resolve = approvals.resolve.bind(approvals);
    approvals.resolve = (...args) => { seen.push(args[4]); return resolve(...args); };
    const agent = new Agent({ router: { status: () => [] }, tools: { list: () => [], schemas: () => [] }, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    const answer = approvals.request({ title: 'x', tier: 'medium', source: 'test' });
    await agent.handle('yes', { from: { deviceId: 'd1' } });
    await expect(answer).resolves.toBe(true);
    expect(seen[0].from).toEqual({ deviceId: 'd1' });
  });

  it('never approves a delete on a spoken "yes" and says why', async () => {
    const approvals = new ApprovalQueue();
    const agent = new Agent({ router: { status: () => [] }, tools: { list: () => [], schemas: () => [] }, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    approvals.request({ title: 'Forget a memory', tier: 'medium', source: 'test', kind: 'delete' });
    expect(await agent.handle('yes')).toMatch(/deletes or pays/);
    expect(approvals.pending()).toHaveLength(1);
  });
});


describe('agent.firstStep (dry run for the understanding test)', () => {
  it('reports the tools the brain would call, without running them or remembering the turn', async () => {
    const { agent, router, ran } = setup([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('code_start_task', { project: 'portfolio' })] }, provider: 'groq', model: 'm' }]);
    const step = await agent.firstStep('fix the navbar in portfolio');
    expect(step).toEqual({ quick: null, calls: [{ name: 'code_start_task', args: { project: 'portfolio' } }], reply: null, provider: 'groq' });
    expect(ran).toEqual([]);
    expect(agent.history).toEqual([]);
    expect(router.calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'fix the navbar in portfolio' });
  });

  it('a plain answer and a quick reply (yes / no / cancel) are reported too', async () => {
    const { agent, router } = setup([reply('Hello!')]);
    expect(await agent.firstStep('hi')).toEqual({ quick: null, calls: [], reply: 'Hello!', provider: 'groq' });
    expect(await agent.firstStep('karle update')).toEqual({ quick: 'approve', calls: [], reply: null, provider: null });
    expect(router.calls).toHaveLength(1);
  });
});
