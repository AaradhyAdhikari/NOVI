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
    expect(await agent.handle('add login to portfolio')).toBe('On it.');
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

  // Live (2026-10-17): the GitHub graph was shown, then "My AI providers are busy…" was added below it.
  it('after a tool already did the job, busy providers add nothing (no "busy" line)', async () => {
    const { agent } = setup([{ message: { role: 'assistant', content: '', tool_calls: [toolCall('code_status', {})] }, provider: 'groq', model: 'm' }, new AllProvidersUnavailableError(21_000)]);
    expect(await agent.handle('show me my github graph')).toBe('');
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
    expect(p).toMatch(/never read out a list/i);
    expect(p).toMatch(/screen_look/);
    expect(p).toMatch(/never say you played, opened, sent or did something unless a tool result/i);
  });
});

describe('YouTube by voice: open it now, then say what to play', () => {
  const ytSetup = (results = { playing: { title: 'Valorant Champions Final' }, on: 'phone' }) => {
    const router = scriptedRouter([]);
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'open_website', description: 'o', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'o', run: async (a) => { ran.push(['open', a]); return { opened: 'https://www.youtube.com/', on: 'laptop' }; } })
      .add({ name: 'play_youtube', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async (a) => { ran.push(['play', a]); return results; } })
      .add({ name: 'weather_get', description: 'w', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'w', run: async () => ({}) });
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    return { agent, router, ran };
  };

  it('"open YouTube" opens it at once (no AI call) and asks what to play; the next answer plays it', async () => {
    const { agent, router, ran } = ytSetup();
    expect(await agent.handle('Open YouTube.')).toBe("YouTube's open. What should I play?");
    expect(ran).toEqual([['open', { target: 'https://www.youtube.com' }]]);
    expect(await agent.handle('Valorant')).toBe('Playing Valorant Champions Final.');
    expect(ran[1]).toEqual(['play', { query: 'Valorant' }]);
    expect(router.calls).toHaveLength(0);
  });

  it('plays straight away when the video is named in the same breath (English or Hinglish)', async () => {
    for (const [text, query] of [
      ['open youtube and show valorant', 'valorant'],
      ['play lofi on youtube', 'lofi'],
      ['youtube pe bgmi news lagao', 'bgmi news'],
      ['youtube kholo aur arijit singh chalao', 'arijit singh'],
      ['youtube open karke bgmi news sunna', 'bgmi news'],
    ]) {
      const { agent, ran } = ytSetup();
      await agent.handle(text);
      expect(ran).toEqual([['play', { query }]]);
    }
  });

  it('after "open YouTube", a different request still goes to the brain', async () => {
    const { agent, router, ran } = ytSetup();
    router.chat = async (req) => { router.calls.push(req); return reply('Sunny, 31 degrees.'); };
    await agent.handle('open youtube');
    expect(await agent.handle("what's the weather")).toBe('Sunny, 31 degrees.');
    expect(ran).toHaveLength(1);
  });

  it('the dry run (understanding test) reports the direct YouTube play', async () => {
    const { agent, ran } = ytSetup();
    expect(await agent.firstStep('play lofi on youtube')).toEqual({ quick: null, calls: [{ name: 'play_youtube', args: { query: 'lofi' } }], reply: null, provider: 'direct' });
    expect(ran).toEqual([]);
  });

  it('logs every tool run (name + ok or the error) so "it said playing but nothing played" can be checked', async () => {
    const { agent } = ytSetup({ error: 'boom' });
    const lines = [];
    agent.logger = { log: (l) => lines.push(l) };
    await agent.handle('play lofi on youtube');
    expect(lines).toEqual(['[tool] play_youtube error: boom']);
  });

  it('says what went wrong instead of pretending to play', async () => {
    const { agent } = ytSetup({ error: "I couldn't read YouTube's results right now." });
    expect(await agent.handle('play lofi on youtube')).toBe("I couldn't read YouTube's results right now.");
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
      .toBe('Claude is working on portfolio. Latest: Editing a.js.');
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

describe('GitHub contribution graph by voice (no AI call)', () => {
  const ghSetup = (out = { login: 'octo', date: 'D', contributions: 2, lastYear: 222 }) => {
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'github_graph', description: 'g', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'g', run: async (a) => { ran.push(a); return { ...out, date: a.date }; } });
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, logger: { log() {} } });
    return { agent, ran };
  };
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('en-CA'); };

  it('sends the graph for yesterday or today, in English, Hinglish and Hindi', async () => {
    for (const [text, offset] of [
      ["Can you give me the screenshot of my Github's contribution yesterday? The whole graph?", -1],
      ['mere kal ke github contribution ka screenshot de', -1],
      ['मेरे कल के GitHub contribution का ss दे', -1],
      ['show my github contribution graph', 0],
    ]) {
      const { agent, ran } = ghSetup();
      const reply = await agent.handle(text);
      expect(ran, text).toEqual([{ date: day(offset) }]);
      expect(reply).toBe(`You made 2 contributions ${offset ? 'yesterday' : 'today'}.`);
    }
  });

  it('"open my GitHub" is a different thing (goes to the brain), and errors are said plainly', async () => {
    const { agent, ran } = ghSetup();
    agent.router.chat = async () => reply('Opening it.');
    await agent.handle('open my github contributions page');
    expect(ran).toEqual([]);
    const bad = ghSetup({ error: "I don't know your GitHub username yet." });
    expect(await bad.agent.handle('github contribution ss')).toBe("I don't know your GitHub username yet.");
  });
});

describe('progress and next step by voice (from the coder\'s plan)', async () => {
  const { describeNext } = await import('../../server/brain/agent.js');
  const plan = [
    { step: 'Create the login page', doing: 'Creating the login page', status: 'completed' },
    { step: 'Add form validation', doing: 'Adding form validation', status: 'in_progress' },
    { step: 'Write tests', doing: 'Writing tests', status: 'pending' },
  ];
  const running = { active: true, agent: 'Claude', status: 'running', project: 'portfolio', recent: ['Editing a.js'], plan };

  it('"what\'s the progress" says the step it is on, very short', () => {
    expect(describeStatus(running)).toBe('Claude is on step 2 of 3 for portfolio: adding form validation. Done so far: create the login page; right now: Editing a.js.');
    for (const t of ["what's the progress", 'progress?', 'progress kya hai', 'kitna hua', 'status']) expect(quickCommand(t), t).toBe('status');
  });

  it('"what\'s next" says the next planned step', () => {
    expect(describeNext(running)).toBe('Next, Claude will write tests. That finishes the plan.');
    const longer = [...plan, { step: 'Deploy it', doing: 'Deploying', status: 'pending' }, { step: 'Add a README', doing: 'Adding a README', status: 'pending' }];
    expect(describeNext({ ...running, plan: longer })).toBe('Next, Claude will write tests, then deploy it. 1 more step after that.');
    expect(describeNext({ ...running, plan: plan.map((p) => ({ ...p, status: p.status === 'pending' ? 'in_progress' : 'completed' })).slice(0, 3) })).toBe('That\'s the last step: writing tests.');
    expect(describeNext({ ...running, plan: [] })).toBe("Claude hasn't shared a plan yet. Latest: Editing a.js.");
    expect(describeNext({ active: false })).toBeNull();
    for (const t of ["what's next", 'what is the next step', 'next step', 'aage kya hai', 'ab kya']) expect(quickCommand(t), t).toBe('next');
  });
});

describe('"show me the … code" goes straight to code_show (no AI call)', async () => {
  const { codeCommand } = await import('../../server/brain/agent.js');
  it('spots code requests in English and Hinglish, not other things', () => {
    expect(codeCommand('Show me the HTML code')).toBe('Show me the HTML code');
    expect(codeCommand('navbar ka code dikhao')).toBe('navbar ka code dikhao');
    // Live (2026-10-17): asked for "the full code" in other words, the same 40 lines came back.
    expect(codeCommand('give me the full code of the header')).toBe('give me the full code of the header');
    expect(codeCommand('Was it the full header code?')).toBe('Was it the full header code?');
    expect(codeCommand('send me the complete navbar code')).toBe('send me the complete navbar code');
    expect(codeCommand('give me a code review')).toBeNull();
    expect(codeCommand('what code did you write for the button? show it')).toBeTruthy();
    expect(codeCommand('show me the weather')).toBeNull();
    expect(codeCommand('fix the code in the navbar')).toBeNull();
  });

  it('runs code_show and says the file', async () => {
    const ran = [];
    const tools = new ToolRegistry().add({ name: 'code_show', description: 'c', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'c', run: async (a) => { ran.push(a); return { file: 'index.html', lines: '1–40' }; } });
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: true }) }, logger: { log() {} } });
    expect(await agent.handle('show me the html code')).toBe("Here's index.html.");
    expect(ran).toEqual([{ what: 'show me the html code' }]);
  });
});

describe('"cancel" while Novi is asking something', () => {
  it('declines the question instead of stopping the coding task', async () => {
    const { agent, approvals } = setup([]);
    let stopped = false;
    agent.tasks.stop = async () => { stopped = true; return true; };
    const pending = approvals.request({ title: 'Tell Claude: add dark mode', tier: 'medium', source: 'novi' });
    expect(await agent.handle('cancel')).toBe('Okay, cancelled. What do you want instead? Tell me.');
    expect(await pending).toBe(false);
    expect(stopped).toBe(false);
    expect(await agent.handle('cancel')).toBe('Okay, I stopped the coding task.');
    expect(stopped).toBe(true);
  });
});

describe('deny by voice', () => {
  it('understands the usual ways of saying no', () => {
    for (const t of ['deny', 'deny it', 'Deny that.', 'decline', 'reject it', "don't allow it", 'no, deny it', 'block it', 'nahi karna']) expect(quickCommand(t), t).toBe('deny');
  });

  it('while a question is waiting, sound-alikes of "deny" (Dino, Denny) deny it — they never play a song', async () => {
    const router = scriptedRouter([]);
    const approvals = new ApprovalQueue();
    const played = [];
    const tools = new ToolRegistry()
      .add({ name: 'open_website', description: 'o', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'o', run: async () => ({ opened: 'https://www.youtube.com/', on: 'laptop' }) })
      .add({ name: 'play_youtube', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async (a) => { played.push(a); return { playing: { title: 'Dino song' } }; } });
    const agent = new Agent({ router, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, logger: { log() {} } });
    await agent.handle('open youtube');
    const pending = approvals.request({ title: 'Claude wants to run a command', tier: 'medium', source: 'claude' });
    expect(await agent.handle('Dino.')).toBe('Okay, denied.');
    expect(await pending).toBe(false);
    expect(played).toEqual([]);
  });
});

describe('answering a waiting question by voice (what speech-to-text writes)', () => {
  it('"Allow." / "A low" approve, "Nay." denies, "always" grants — no AI call', async () => {
    const { agent, approvals, router } = setup([]);
    for (const [said, allowed, reply] of [['Allow.', true, 'Approved.'], ['A low', true, 'Approved.'], ['Nay.', false, 'Okay, denied.'], ['haan kar do', true, 'Approved.']]) {
      const pending = approvals.request({ title: 'Click "New Project"', tier: 'medium', source: 'novi' });
      expect(await agent.handle(said), said).toBe(reply);
      expect(await pending, said).toBe(allowed);
    }
    expect(router.calls).toHaveLength(0);
  });
});

describe('direct project commands (no free AI in the middle)', async () => {
  const { renameCommand, claudeCommand } = await import('../../server/brain/agent.js');
  it('"rename my folder named Sample Project to Calculator Maker"', () => {
    expect(renameCommand('Rename my folder named Sample Project to Calculator Maker in Claude.')).toEqual({ name: 'Sample Project', newName: 'Calculator Maker' });
    expect(renameCommand('change the name of sample project to calculator maker')).toEqual({ name: 'sample project', newName: 'calculator maker' });
    expect(renameCommand('rename the project to Calc')).toEqual({ name: null, newName: 'Calc' });
    expect(renameCommand('rename Sample Project as Calc')).toEqual({ name: 'Sample Project', newName: 'Calc' });
    expect(renameCommand('sample project ka naam calc kar do')).toEqual({ name: 'sample project', newName: 'calc' });
    expect(renameCommand('name the project Calc Maker')).toEqual({ name: null, newName: 'Calc Maker' });
    expect(renameCommand('what is the weather')).toBeNull();
  });

  it('"ask Claude to …" / "in Claude, …" goes straight to Claude Code with the user\'s own words', () => {
    expect(claudeCommand('Ask Claude to add a dark mode toggle')).toBe('add a dark mode toggle');
    expect(claudeCommand('Claude, fix the login bug')).toBe('fix the login bug');
    expect(claudeCommand('in Claude make the buttons rounded')).toBe('make the buttons rounded');
    expect(claudeCommand('use Claude to write tests for the calculator')).toBe('write tests for the calculator');
    expect(claudeCommand('open Claude on my laptop')).toBeNull();
    expect(claudeCommand('use Claude instead')).toBeNull();
    expect(claudeCommand("what's the weather")).toBeNull();
  });

  it('renames through rename_project, using the current project when none is named', async () => {
    const ran = [];
    const tools = new ToolRegistry().add({ name: 'rename_project', description: 'r', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'r', run: async (a) => { ran.push(a); return { note: 'Renamed it to Calc.' }; } });
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: true, project: 'sample project' }) }, logger: { log() {} } });
    expect(await agent.handle('rename the project to Calc')).toBe('Renamed it to Calc.');
    expect(ran).toEqual([{ name: 'sample project', newName: 'Calc' }]);
  });

  it('Claude jobs: a change while a task runs, else a new Claude task on the current project', async () => {
    const ran = [];
    const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async (a) => { ran.push([name, a]); return { note: 'ok' }; } });
    const tools = new ToolRegistry().add(tool('code_send_message')).add(tool('code_start_task'));
    let status = { active: true, status: 'running', project: 'calc' };
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => status }, logger: { log() {} } });
    await agent.handle('ask Claude to add dark mode');
    status = { active: true, status: 'done', project: 'calc' };
    await agent.handle('Claude, add a history panel');
    expect(ran).toEqual([['code_send_message', { instruction: 'add dark mode' }], ['code_start_task', { project: 'calc', instruction: 'add a history panel', agent: 'claude' }]]);
  });

  it('a project named in the words wins; with no project at all the brain decides', async () => {
    const ran = [];
    const tools = new ToolRegistry().add({ name: 'code_start_task', description: 's', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 's', run: async (a) => { ran.push(a); return { note: 'ok' }; } });
    const router = scriptedRouter([reply('Which project?')]);
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [{ name: 'portfolio', path: 'C:\\p' }] }, tasks: { status: () => ({ active: false }) }, logger: { log() {} } });
    await agent.handle('ask Claude to add login to portfolio');
    expect(ran).toEqual([{ project: 'portfolio', instruction: 'add login to portfolio', agent: 'claude' }]);
    expect(await agent.handle('ask Claude to build a calculator')).toBe('Which project?');
  });
});

describe('a few seconds of "busy" are waited out, not said', () => {
  it('any turn waits up to 5 s once instead of answering "try again in 1 seconds"', async () => {
    const waits = [];
    const router = scriptedRouter([new AllProvidersUnavailableError(1000), reply('A joke.')]);
    const agent = new Agent({ router, tools: new ToolRegistry(), approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, sleep: async (ms) => { waits.push(ms); }, logger: { log() {} } });
    expect(await agent.handle('tell me a joke')).toBe('A joke.');
    expect(waits).toEqual([1000]);
  });
});

describe('"also …" adds to the job', async () => {
  const { alsoCommand } = await import('../../server/brain/agent.js');
  it('spots "also X" (English / Hinglish), with or without a yes in front', () => {
    expect(alsoCommand('also add dark mode')).toBe('add dark mode');
    expect(alsoCommand('Yes, also make the buttons round.')).toBe('make the buttons round');
    expect(alsoCommand('okay and also add a history panel')).toBe('add a history panel');
    expect(alsoCommand('aur dark mode bhi add karo')).toBe('dark mode bhi add karo');
    expect(alsoCommand('what is also called')).toBeNull();
    expect(alsoCommand('add dark mode')).toBeNull();
  });

  const coderSetup = (status = { active: false }) => {
    const router = scriptedRouter([]);
    const approvals = new ApprovalQueue();
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'code_start_task', description: 's', parameters: { type: 'object', properties: { project: { type: 'string' }, instruction: { type: 'string' } } }, tier: 'medium', describe: (a) => `Start on ${a.project}`, run: async (a) => { ran.push(['start', a]); return { note: 'Started.' }; } })
      .add({ name: 'code_send_message', description: 'm', parameters: { type: 'object', properties: { instruction: { type: 'string' } } }, tier: 'medium', describe: () => 'm', run: async (a) => { ran.push(['send', a]); return { note: 'Sent.' }; } });
    const agent = new Agent({ router, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => status }, logger: { log() {} } });
    return { agent, approvals, ran, router };
  };

  it('while Novi asks: "also X" = yes, and X is added to the coder\'s instruction', async () => {
    const { agent, approvals, ran } = coderSetup();
    const run = agent._runTool({ id: 'c1', function: { name: 'code_start_task', arguments: JSON.stringify({ project: 'calc', instruction: 'build a calculator' }) } });
    await new Promise((r) => setTimeout(r, 0));
    expect(approvals.pending()[0].addable).toBe(true);
    expect(await agent.handle('also add dark mode')).toBe("Okay, I'll add that too.");
    await run;
    expect(ran).toEqual([['start', { project: 'calc', instruction: 'build a calculator\n\nAlso: add dark mode' }]]);
  });

  it('while the coder works (nothing asked): "also X" goes straight to it, no extra question', async () => {
    const { agent, approvals, ran, router } = coderSetup({ active: true, status: 'running', project: 'calc' });
    expect(await agent.handle('also make the buttons round')).toBe('Sent.');
    expect(ran).toEqual([['send', { instruction: 'make the buttons round' }]]);
    expect(approvals.pending()).toEqual([]);
    expect(router.calls).toHaveLength(0);
  });
});

describe('file commands go straight to the file tools (no AI in the middle)', async () => {
  const { fileCommand } = await import('../../server/brain/agent.js');
  it('open / summarize / gather / undo', () => {
    expect(fileCommand('open my DBMS notes pdf')).toEqual({ tool: 'file_open', args: { query: 'open my DBMS notes pdf' } });
    expect(fileCommand('DBMS ki notes wali file kholo')).toEqual({ tool: 'file_open', args: { query: 'DBMS ki notes wali file kholo' } });
    expect(fileCommand('summarize the sales analysis sheet')).toEqual({ tool: 'file_summary', args: { query: 'the sales analysis sheet' } });
    expect(fileCommand('give me a summary of my budget google sheet')).toEqual({ tool: 'file_summary', args: { query: 'my budget google sheet', where: 'google' } });
    expect(fileCommand('take all the PDFs about DBMS and put them in a folder')).toEqual({ tool: 'file_gather', args: { topic: 'DBMS', kind: 'pdf' } });
    expect(fileCommand('move all my documents on operating systems into a folder called OS notes')).toEqual({ tool: 'file_gather', args: { topic: 'operating systems', kind: 'doc', folder: 'OS notes' } });
    expect(fileCommand('undo that')).toEqual({ tool: 'file_undo_move', args: {} });
  });

  it('takes the way it is actually said: "okay", "hey Novi", "can you", "on my laptop", "right now"', () => {
    expect(fileCommand('Okay, open a file named Tracebyte Context on my laptop right now.')).toEqual({ tool: 'file_open', args: { query: 'open a file named Tracebyte Context' } });
    expect(fileCommand('Hey Novi, can you please open the file called budget 2026')).toEqual({ tool: 'file_open', args: { query: 'open the file called budget 2026' } });
    expect(fileCommand('Okay, open my Claude Code.')).toEqual({ tool: 'open_project', args: { editor: 'claude-code' } });
    expect(fileCommand('open claude')).toEqual({ tool: 'open_project', args: { editor: 'claude-code' } });
    expect(fileCommand('open Claude on my laptop')).toEqual({ tool: 'open_project', args: { editor: 'claude-code' } });
    expect(fileCommand('ok summarize my sales sheet for me')).toEqual({ tool: 'file_summary', args: { query: 'my sales sheet' } });
  });

  it('leaves everything else alone', () => {
    for (const t of ['okay open youtube', 'open youtube', 'open Novi in Cursor', 'open my project folder in vs code', "what's the weather", 'summarize my day']) expect(fileCommand(t), t).toBeNull();
  });

  it('runs the tool and says its note', async () => {
    const ran = [];
    const tools = new ToolRegistry().add({ name: 'file_open', description: 'f', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'f', run: async (a) => { ran.push(a); return { opened: 'DBMS Notes.pdf' }; } });
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, logger: { log() {} } });
    expect(await agent.handle('open my DBMS notes pdf')).toBe('Opened DBMS Notes.pdf.');
    expect(ran).toEqual([{ query: 'open my DBMS notes pdf' }]);
  });
});


describe('the AI may not claim an action it never ran', () => {
  it('pushes back once, and the AI then runs the tool', async () => {
    const { agent, router, ran } = setup([
      reply('Opened the C language folder for you.'),
      { message: { role: 'assistant', content: '', tool_calls: [toolCall('code_start_task', { project: 'portfolio' })] }, provider: 'groq', model: 'm' },
      reply('Claude is working on it.'),
    ], { autoAnswer: true });
    await agent.handle('do the thing in portfolio');
    expect(ran).toHaveLength(1);
    expect(JSON.stringify(router.calls[1].messages)).toMatch(/did not run any tool/);
  });

  it('says so honestly when the AI claims it again', async () => {
    const { agent } = setup([reply('Opened the C language folder for you.'), reply('Done, opened it.')]);
    const out = await agent.handle('open the c language folder');
    expect(out).not.toMatch(/^Opened/);
    expect(out).toMatch(/couldn't|didn't/i);
  });

  it('leaves ordinary answers alone', async () => {
    const { agent, router } = setup([reply('It is 25 degrees and sunny.')]);
    expect(await agent.handle('weather?')).toBe('It is 25 degrees and sunny.');
    expect(router.calls).toHaveLength(1);
  });
});

describe('folders and "in my laptop" go straight to the file tools', async () => {
  const { fileCommand } = await import('../../server/brain/agent.js');
  it('opens a folder', () => {
    expect(fileCommand('Open C language folder in my laptop.')).toEqual({ tool: 'file_open', args: { query: 'Open C language folder' } });
    expect(fileCommand('open my DBMS folder on laptop')).toEqual({ tool: 'file_open', args: { query: 'open my DBMS folder' } });
  });
});

describe('"make a folder called X" goes straight to file_new_folder', async () => {
  const { fileCommand } = await import('../../server/brain/agent.js');
  it('name, and an optional place', () => {
    expect(fileCommand('Create a new folder named Hackathon Ideas')).toEqual({ tool: 'file_new_folder', args: { name: 'Hackathon Ideas' } });
    expect(fileCommand('okay make a folder called test on my desktop')).toEqual({ tool: 'file_new_folder', args: { name: 'test', where: 'desktop' } });
    expect(fileCommand('create a folder named Unit 2 inside my College folder')).toEqual({ tool: 'file_new_folder', args: { name: 'Unit 2', where: 'College' } });
    expect(fileCommand('make a new folder called Notes in downloads on my laptop')).toEqual({ tool: 'file_new_folder', args: { name: 'Notes', where: 'downloads' } });
    expect(fileCommand('Hackathon naam ka folder banao')).toEqual({ tool: 'file_new_folder', args: { name: 'Hackathon' } });
  });
});

describe('fewer questions: one thing you asked for directly just runs', () => {
  const medium = (name, ran) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => name, run: async (a) => { ran.push([name, a]); return { note: `${name} done.` }; } });
  const make = (steps = []) => {
    const ran = [];
    const asked = [];
    const approvals = new ApprovalQueue();
    approvals.on('added', (a) => { asked.push(a.title); approvals.resolve(a.id, true); });
    const tools = new ToolRegistry().add(medium('rename_project', ran)).add(medium('file_gather', ran)).add(medium('screen_click', ran));
    const agent = new Agent({ router: scriptedRouter(steps), tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    return { agent, ran, asked };
  };

  it('a direct command runs without asking', async () => {
    const { agent, ran, asked } = make();
    await agent._runTool({ id: 'x', function: { name: 'rename_project', arguments: '{}' } }, { direct: true });
    expect(ran).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('moving many files Novi picked still asks once', async () => {
    const { agent, asked } = make();
    await agent._runTool({ id: 'x', function: { name: 'file_gather', arguments: '{}' } }, { direct: true });
    expect(asked).toHaveLength(1);
  });

  it('one yes covers the rest of the same request (no question per click)', async () => {
    const { agent, ran, asked } = make([
      { message: { role: 'assistant', content: '', tool_calls: [toolCall('screen_click', {}, 'a')] }, provider: 'groq', model: 'm' },
      { message: { role: 'assistant', content: '', tool_calls: [toolCall('screen_click', {}, 'b'), toolCall('screen_click', {}, 'c')] }, provider: 'groq', model: 'm' },
      reply('Made it.'),
    ]);
    await agent.handle('make a project named calc inside the claude app');
    expect(ran).toHaveLength(3);
    expect(asked).toHaveLength(1);
  });
});

describe('spoken approval is only the task', async () => {
  const { spokenApproval } = await import('../../server/brain/answers.js');
  it('no "OK?" on the end', () => {
    expect(spokenApproval({ title: 'x', prompt: 'Rename calc to Calculator. OK?' })).toBe('Rename calc to Calculator.');
    expect(spokenApproval({ title: 'Click “Send”' })).toBe('Click “Send”.');
  });
});

describe('after_tool_call', () => {
  it('the agent tells plugins about each tool run, with its result or error', async () => {
    const events = [];
    const tools = new ToolRegistry()
      .add({ name: 'ok', description: 'o', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'o', run: async () => ({ created: '/x' }) })
      .add({ name: 'bad', description: 'b', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'b', run: async () => { throw new Error('nope'); } });
    tools.afterToolCall = async (e) => { events.push(e); };
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    await agent._runTool({ id: '1', function: { name: 'ok', arguments: '{"a":1}' } });
    await agent._runTool({ id: '2', function: { name: 'bad', arguments: '{}' } });
    expect(events[0]).toMatchObject({ toolName: 'ok', params: { a: 1 }, result: { created: '/x' } });
    expect(events[1]).toMatchObject({ toolName: 'bad', error: 'nope' });
  });
});

describe('memory by voice: "it", "what did you do", notes', async () => {
  const { memoryCommand } = await import('../../server/brain/agent.js');
  const NOW = new Date(2026, 9, 15, 15, 0);
  const at = (h) => new Date(2026, 9, 15, h, 0).toISOString();
  const recent = [
    { at: at(14), tool: 'file_new_folder', verb: 'Made folder', name: 'test', path: 'C:\\D\\test' },
    { at: at(13), tool: 'open_app', verb: 'Opened app', name: 'Spotify', path: '' },
    { at: at(12), tool: 'open_project', verb: 'Opened project', name: 'calc', path: 'C:\\P\\calc', project: true },
    { at: new Date(2026, 9, 14, 9).toISOString(), tool: 'file_open', verb: 'Opened', name: 'old.pdf', path: 'C:\\old.pdf' },
  ];

  it('"rename it to X" renames the newest thing with a path; a project goes through rename_project', () => {
    expect(memoryCommand('rename it to demo', null)).toEqual({ needsRecent: true });
    expect(memoryCommand('what did you do today?', null)).toEqual({ needsRecent: true });
    expect(memoryCommand('open spotify', null)).toBe(null);
    expect(memoryCommand('note that the exam is on 3 Nov', null)).toMatchObject({ tool: 'note_write' });
    expect(memoryCommand('Okay, rename it to demo', recent, NOW)).toEqual({ tool: 'file_rename', args: { path: 'C:\\D\\test', newName: 'demo' } });
    expect(memoryCommand('rename that folder as demo two', recent, NOW)).toEqual({ tool: 'file_rename', args: { path: 'C:\\D\\test', newName: 'demo two' } });
    expect(memoryCommand('rename it to calculator', [recent[2]], NOW)).toEqual({ tool: 'rename_project', args: { name: 'calc', newName: 'calculator' } });
    expect(memoryCommand('rename it to demo', [], NOW)).toEqual({ reply: 'Rename what? Tell me the name.' });
  });

  // Live (2026-10-17): "Now delete this folder." went to the AI, which deleted it through screen control.
  it('"delete this folder" / "delete it" → file_delete on that exact path', () => {
    expect(memoryCommand('Now delete this folder.', null)).toEqual({ needsRecent: true });
    expect(memoryCommand('Now delete this folder.', recent, NOW)).toEqual({ tool: 'file_delete', args: { path: 'C:\\D\\test' } });
    expect(memoryCommand('delete it', [], NOW)).toEqual({ reply: 'Delete what? Tell me the name.' });
  });

  it('"open the folder you just made" / "open it" opens that exact path', () => {
    expect(memoryCommand('open the folder you just made', recent, NOW)).toEqual({ tool: 'file_open', args: { path: 'C:\\D\\test' } });
    expect(memoryCommand('open it', recent, NOW)).toEqual({ tool: 'file_open', args: { path: 'C:\\D\\test' } });
    expect(memoryCommand('open it', [], NOW)).toEqual({ reply: 'Open what? Tell me the name.' });
  });

  it('"what did you do today" is read from the log, no AI', () => {
    expect(memoryCommand('what did you do today?', recent, NOW)).toEqual({ reply: 'Today I did 3 things. Last: made folder test, opened app Spotify, opened project calc.' });
    expect(memoryCommand('aaj kya kiya', [], NOW)).toEqual({ reply: 'Nothing yet today.' });
  });

  it('notes: write, ask, open', () => {
    expect(memoryCommand('note that the DBMS exam is on 3 Nov', recent, NOW)).toEqual({ tool: 'note_write', args: { text: 'the DBMS exam is on 3 Nov' } });
    expect(memoryCommand('remember in my notes that I owe Rahul 200', recent, NOW)).toEqual({ tool: 'note_write', args: { text: 'I owe Rahul 200' } });
    expect(memoryCommand('add to my DBMS plan note: unit 3 is normalization', recent, NOW)).toEqual({ tool: 'note_write', args: { title: 'DBMS plan', text: 'unit 3 is normalization' } });
    expect(memoryCommand('write a note about hackathon: demo at 5', recent, NOW)).toEqual({ tool: 'note_write', args: { title: 'hackathon', text: 'demo at 5' } });
    expect(memoryCommand('check my notes about the DBMS exam', recent, NOW)).toEqual({ tool: 'notes_ask', args: { question: 'the DBMS exam' } });
    expect(memoryCommand('what do my notes say about Rahul?', recent, NOW)).toEqual({ tool: 'notes_ask', args: { question: 'Rahul' } });
    expect(memoryCommand('open my DBMS plan note', recent, NOW)).toEqual({ tool: 'note_open', args: { title: 'DBMS plan' } });
  });

  it('leaves everything else alone', () => {
    for (const t of ['rename sample project to calc', 'open my DBMS notes', 'open youtube', "what's the weather", 'make a folder called x']) expect(memoryCommand(t, recent, NOW), t).toBeNull();
  });
});

describe('long chats keep earlier context', () => {
  const make = (summarize) => {
    const agent = new Agent({ router: {}, tools: new ToolRegistry(), approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, summarize });
    for (let i = 0; i < 10; i++) agent.history.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
    return agent;
  };

  it('past 20 messages, the oldest 10 become one "Earlier in this chat" line', async () => {
    const seen = [];
    const agent = make(async (text) => { seen.push(text); return 'They talked about DBMS.'; });
    agent._remember('q10', 'a10');
    await agent._summarizing;
    expect(agent.history).toHaveLength(13);
    expect(agent.history[0]).toEqual({ role: 'system', content: 'Earlier in this chat: They talked about DBMS.' });
    expect(seen[0]).toMatch(/^Summarize in 2 sentences what was said:/);
    expect(seen[0]).toContain('q0');
    expect(seen[0]).not.toContain('q5');
  });

  it('a failing summary just drops those 10 messages', async () => {
    const agent = make(async () => { throw new Error('busy'); });
    expect(agent._remember('q10', 'a10')).toBe('a10');
    await agent._summarizing;
    expect(agent.history).toHaveLength(12);
    expect(agent.history[0]).toEqual({ role: 'user', content: 'q5' });
  });
});

describe('web search by voice', () => {
  it('webCommand: "search the web for X", "google X", "X internet pe dekho"', async () => {
    const { webCommand } = await import('../../server/brain/agent.js');
    expect(webCommand('Search the web for iPhone 18 price')).toEqual({ tool: 'web_search', args: { query: 'iPhone 18 price' } });
    expect(webCommand('okay google who won the match yesterday')).toEqual({ tool: 'web_search', args: { query: 'who won the match yesterday' } });
    expect(webCommand('look up Groq new models online')).toEqual({ tool: 'web_search', args: { query: 'Groq new models' } });
    expect(webCommand('search online for flights to Goa')).toEqual({ tool: 'web_search', args: { query: 'flights to Goa' } });
    expect(webCommand('petrol ka rate internet pe dekho')).toEqual({ tool: 'web_search', args: { query: 'petrol ka rate' } });
    expect(webCommand('google pe search karo IPL schedule')).toEqual({ tool: 'web_search', args: { query: 'IPL schedule' } });
    for (const t of ['open google', 'search my files for DBMS', 'search my notes for DBMS', 'what is the weather', 'google']) expect(webCommand(t), t).toBe(null);
  });

  it('answers straight from the search (no AI), naming the sites', async () => {
    const { webReply } = await import('../../server/brain/agent.js');
    expect(webReply({ answer: 'India won by 6 wickets.', sources: [{ title: 'A', url: 'https://www.espncricinfo.com/x' }, { title: 'B', url: 'https://bbc.com/y' }] }))
      .toBe('India won by 6 wickets. (espncricinfo.com, bbc.com)');
    expect(webReply({ answer: null, sources: [{ title: 'Groq models list', url: 'https://groq.com/m' }, { title: 'News', url: 'https://n.com' }] }))
      .toBe('Top results: Groq models list (groq.com); News (n.com).');
    expect(webReply({ error: 'Web search is not set up.' })).toBe('Web search is not set up.');
  });
});

describe('web search by voice: the agent', () => {
  it('"search the web for X" runs web_search directly and says the answer (router never called)', async () => {
    const seen = [];
    const tools = new ToolRegistry().add({ name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 's', run: async (a) => { seen.push(a); return { answer: 'It is 42.', sources: [{ title: 'A', url: 'https://a.com/x' }] }; } });
    const router = { chat: async () => { throw new Error('the AI should not be asked'); } };
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('search the web for the answer to everything')).toBe('It is 42. (a.com)');
    expect(seen).toEqual([{ query: 'the answer to everything' }]);
  });
});

describe('plugin approvals know who asked', () => {
  it('the device that asked reaches before_tool_call', async () => {
    const { PluginHost } = await import('../../server/plugins/host.js');
    const { definePluginEntry } = await import('../../server/plugins/sdk.js');
    const seen = [];
    const tools = new PluginHost({ logger: { warn() {} } });
    tools.register(definePluginEntry({ id: 'p', name: 'P', register(api) {
      api.registerTool({ name: 'p_do', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: { done: true } }) });
      api.on('before_tool_call', (e) => { seen.push(e.from); });
    } }));
    const steps = [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'p_do', arguments: '{}' } }] }, provider: 'groq' }, { message: { role: 'assistant', content: 'Ok, it ran.' }, provider: 'groq' }];
    let i = 0;
    const agent = new Agent({ router: { chat: async () => steps[i++] }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    await agent.handle('do the thing', { from: { deviceId: 'p1' } });
    expect(seen).toEqual([{ deviceId: 'p1' }]);
  });
});

describe('laptop control by voice', () => {
  const make = (outputs = {}) => {
    const ran = [];
    const tools = new ToolRegistry();
    for (const name of ['laptop_volume', 'laptop_power', 'laptop_clipboard', 'laptop_window', 'laptop_media']) {
      tools.add({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async (a) => { ran.push([name, a]); return (outputs[name] || (() => ({ note: 'ok.' })))(a); } });
    }
    const router = { chat: async () => ({ message: { role: 'assistant', content: 'The answer is 42.' }, provider: 'groq' }) };
    const stopped = [];
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }), stop: async () => { stopped.push(true); return true; } } });
    return { agent, ran, stopped, router };
  };

  it('"volume 30" runs directly and says the note (the AI is not asked)', async () => {
    const { agent, ran, router } = make({ laptop_volume: () => ({ level: 30, note: 'Volume 30.' }) });
    router.chat = async () => { throw new Error('no AI'); };
    expect(await agent.handle('volume 30')).toBe('Volume 30.');
    expect(ran).toEqual([['laptop_volume', { level: 30 }]]);
  });

  it('"copy your answer" copies Novi\'s last reply; with none, says so', async () => {
    const { agent, ran } = make({ laptop_clipboard: () => ({ note: 'Copied.' }) });
    expect(await agent.handle('copy your answer')).toBe("There's nothing to copy yet.");
    await agent.handle('what is six times seven');
    expect(await agent.handle('copy your answer')).toBe('Copied.');
    expect(ran.at(-1)).toEqual(['laptop_clipboard', { do: 'set', text: 'The answer is 42.' }]);
  });

  it('"cancel" during a shut down countdown cancels the shut down, not a coding task', async () => {
    const { agent, ran, stopped } = make({ laptop_power: (a) => (a.action === 'shutdown' ? { note: 'Shutting down in 15 seconds. Say cancel to stop.', countdownUntil: Date.now() + 15_000 } : { note: 'Okay, cancelled.' }) });
    expect(await agent.handle('shut down the laptop')).toBe('Shutting down in 15 seconds. Say cancel to stop.');
    expect(await agent.handle('cancel')).toBe('Okay, cancelled.');
    expect(ran.at(-1)).toEqual(['laptop_power', { action: 'cancel' }]);
    expect(stopped).toEqual([]);
    await agent.handle('cancel'); // already cancelled: "cancel" means what it did before
    await agent.handle('shut down');
    agent._countdown.until = Date.now() - 1; // countdown over
    await agent.handle('cancel');
    expect(ran.filter(([, a]) => a.action === 'cancel')).toHaveLength(1);
  });

  it('"go to X" with no such window goes on to the AI (it may be a website)', async () => {
    const { agent, ran } = make({ laptop_window: () => ({ error: "I don't see a window for youtube.", notFound: true }) });
    expect(await agent.handle('go to youtube')).toBe('The answer is 42.');
    expect(ran).toEqual([['laptop_window', { app: 'youtube', do: 'focus' }]]);
  });
});

describe('laptop control: direct commands still ask before turning things off', () => {
  it('"close chrome" and "lock the laptop" ask even when said directly; "no" leaves them alone', async () => {
    const { PluginHost } = await import('../../server/plugins/host.js');
    const { createLaptopControlPlugin } = await import('../../plugins/laptop-control/index.js');
    const calls = [];
    const worker = { run: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'windows' ? { windows: [{ id: 3, title: 'Gmail - Google Chrome', process: 'chrome' }] } : {}; } };
    const tools = new PluginHost({ logger: { warn() {} } });
    tools.register(createLaptopControlPlugin({ worker, platform: 'win32', pause: async () => {} }));
    const approvals = new ApprovalQueue();
    const asked = [];
    approvals.on('added', (a) => { asked.push(a.title); approvals.resolve(a.id, false); });
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    await agent.handle('close chrome');
    await agent.handle('lock the laptop');
    expect(asked).toEqual(['Close Chrome?', 'Lock the laptop?']);
    expect(calls.filter(([c]) => c === 'window' || c === 'lock')).toEqual([]);
    await agent.handle('volume 20');
    expect(asked).toHaveLength(2);
    expect(calls.at(-1)).toEqual(['volume', { level: 20 }]);
  });
});

describe('pin approvals reach the approval queue', () => {
  it('the agent passes pin: true to approvals.decide', async () => {
    const { PluginHost } = await import('../../server/plugins/host.js');
    const { definePluginEntry } = await import('../../server/plugins/sdk.js');
    const tools = new PluginHost({ logger: { warn() {} } });
    tools.register(definePluginEntry({ id: 'p', name: 'P', register(api) {
      api.registerTool({ name: 'p_do', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: { done: true } }) });
      api.on('before_tool_call', () => ({ requireApproval: { title: 'Delete it?', severity: 'warning', pin: true } }));
    } }));
    const seen = [];
    const approvals = { decide: async (a) => { seen.push(a); return { allow: false }; }, latest: () => null };
    const steps = [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'p_do', arguments: '{}' } }] }, provider: 'groq' }, { message: { role: 'assistant', content: 'Okay, I did not.' }, provider: 'groq' }];
    let i = 0;
    const agent = new Agent({ router: { chat: async () => steps[i++] }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    await agent.handle('delete it');
    expect(seen[0]).toMatchObject({ title: 'Delete it?', pin: true });
  });
});

describe('laptop commands: a direct route never skips the question', () => {
  it('laptop_run (a change) asks even when run directly', async () => {
    const { PluginHost } = await import('../../server/plugins/host.js');
    const { createCommandsPlugin } = await import('../../plugins/commands/index.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createHistory } = await import('../../plugins/commands/history.js');
    const runs = [];
    const tools = new PluginHost({ logger: { warn() {} } });
    tools.register(createCommandsPlugin({ runner: { run: async (a) => { runs.push(a); return { ok: true, exitCode: 0, output: '' }; } }, history: createHistory({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-a-')), 'h.jsonl') }) }));
    const approvals = new ApprovalQueue();
    const asked = [];
    approvals.on('added', (a) => { asked.push(a.title); approvals.resolve(a.id, false); });
    const agent = new Agent({ router: {}, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    agent._turnYes = new Set();
    const { output } = await agent._runTool({ id: 'x', function: { name: 'laptop_run', arguments: JSON.stringify({ command: 'Stop-Process -Name notepad', purpose: 'Close Notepad' }) } }, { direct: true });
    expect(asked).toEqual(['Close Notepad?']);
    expect(runs).toEqual([]);
    expect(output.error).toMatch(/declined/);
  });
});

describe('laptop commands: history by voice', () => {
  it('"what commands did you run today" answers from the history, not the AI', async () => {
    const tools = new ToolRegistry().add({ name: 'commands_history', description: 'h', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'h', run: async () => ({ note: '2 today. Last: a, b.', entries: [] }) });
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('what commands did you run today?')).toBe('2 today. Last: a, b.');
  });
});

describe('WhatsApp by voice: find the file, prepare, send (your command is the yes)', () => {
  // The user's decision (2026-10-17): "I am commanding it to msg, it should msg with no questions asked."
  it('"send my DBMS notes folder to Rahul on WhatsApp" finds it, prepares and sends without asking', async () => {
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'file_find', description: 'f', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'f', run: async (a) => { ran.push(['file_find', a]); return { files: [{ name: 'DBMS notes', folder: '/home/me/Documents', folderItself: true }] }; } })
      .add({ name: 'whatsapp_prepare', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async (a) => { ran.push(['whatsapp_prepare', a]); return { ready: { name: 'Rahul Sharma', what: 'DBMS notes.zip (3 MB)', via: 'web' } }; } })
      .add({ name: 'whatsapp_send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send DBMS notes.zip (3 MB) to Rahul Sharma?', run: async () => { ran.push(['whatsapp_send']); return { note: 'Sent.' }; } });
    const approvals = new ApprovalQueue();
    const asked = [];
    approvals.on('added', (a) => { asked.push(a.title); approvals.resolve(a.id, true); });
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('send my DBMS notes folder to Rahul on WhatsApp')).toBe('Sent.');
    expect(ran[0]).toEqual(['file_find', { query: 'DBMS notes folder' }]);
    expect(ran[1][1]).toEqual({ to: 'Rahul', path: (await import('node:path')).join('/home/me/Documents', 'DBMS notes') });
    expect(ran[2]).toEqual(['whatsapp_send']);
    expect(asked).toEqual([]);
  });

  it('nothing found → says so, nothing prepared', async () => {
    const tools = new ToolRegistry()
      .add({ name: 'file_find', description: 'f', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'f', run: async () => ({ files: [] }) })
      .add({ name: 'whatsapp_prepare', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async () => { throw new Error('should not run'); } });
    const agent = new Agent({ router: {}, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('send my DBMS notes folder to Rahul on WhatsApp')).toBe("I can't find DBMS notes.");
  });
});

describe('system prompt: websites vs videos (live 2026-10-15)', () => {
  it('login / forms / clicking a site go through the browser tools; LeetCode is never a video', async () => {
    const { systemPrompt } = await import('../../server/brain/agent.js');
    const p = systemPrompt({ projects: [], task: { active: false } });
    expect(p).toMatch(/log in, fill a form, click or read a page[^.]*browser_open/);
    expect(p).toMatch(/never play a video for LeetCode/);
  });
});

describe('WhatsApp: "her" = the last person messaged (live 2026-10-15)', () => {
  it('after messaging Isha, "send a message to her saying …" goes to Ishaa again without the AI', async () => {
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'whatsapp_prepare', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async (a) => { ran.push(a); return { ready: { name: 'Ishaa', what: `"${a.text}"`, via: 'app' } }; } })
      .add({ name: 'whatsapp_send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send?', run: async () => ({ note: 'Sent.' }) });
    const approvals = new ApprovalQueue();
    approvals.on('added', (a) => approvals.resolve(a.id, true));
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('message Isha that hi')).toBe('Sent.');
    expect(await agent.handle('Send a message to her saying that you are short.')).toBe('Sent.');
    expect(ran[1]).toEqual({ to: 'Ishaa', text: 'you are short' });
  });

  // Live (2026-10-17): "Message Isha that I am late on WhatsApp" typed "I am late on WhatsApp".
  it('"… on WhatsApp" at the end is where to send it, not part of the message', async () => {
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'whatsapp_prepare', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async (a) => { ran.push(a); return { ready: { name: 'Ishaa', what: `"${a.text}"`, via: 'web' } }; } })
      .add({ name: 'whatsapp_send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send?', run: async () => ({ note: 'Sent to Ishaa.' }) });
    const approvals = new ApprovalQueue();
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('Message Isha that I am late on WhatsApp.')).toBe('Sent to Ishaa.');
    expect(ran[0]).toEqual({ to: 'Isha', text: 'I am late' });
    expect(approvals.pending()).toHaveLength(0);
  });
});

describe("Claude asks: answers by voice (coding control v1)", () => {
  const mk = () => {
    const approvals = new ApprovalQueue();
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools: new ToolRegistry(), approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: true }) } });
    const ask = () => approvals.decide({ title: 'Claude asks: Which color theme?', tier: 'medium', source: 'claude', prompt: 'Claude asks: Which color theme? One, Dark. Two, Light.', question: { text: 'Which color theme?', options: [{ label: 'Dark' }, { label: 'Light' }], multiSelect: false }, timeoutMs: null });
    return { approvals, agent, ask };
  };

  it('while Claude asks, "doosra" / own words answer it; a yes/no card keeps "yes"', async () => {
    const { approvals, agent, ask } = mk();
    const yesNo = approvals.decide({ title: 'Claude wants to run npm install', tier: 'medium', source: 'claude' });
    const q1 = ask();
    expect(await agent.handle('doosra')).toBe('Okay, I told Claude: Light.');
    expect(await q1).toMatchObject({ allow: true, answer: 'Light' });
    const q2 = ask();
    await agent.handle('yes');
    expect((await yesNo).allow).toBe(true);
    expect(approvals.waitingQuestion()).not.toBe(null);
    expect(await agent.handle('make it purple')).toBe('Okay, I told Claude: make it purple.');
    expect(await q2).toMatchObject({ allow: true, answer: 'make it purple' });
  });

  it('"skip" lets Claude choose', async () => {
    const { agent, ask } = mk();
    const q = ask();
    expect(await agent.handle('skip')).toBe('Okay, Claude will choose.');
    expect((await q).allow).toBe(false);
  });

  it('the spoken card is the numbered question', async () => {
    const { spokenApproval } = await import('../../server/brain/answers.js');
    expect(spokenApproval({ title: 'Claude asks: Which color theme?', tier: 'medium', prompt: 'Claude asks: Which color theme? One, Dark. Two, Light.', question: {} })).toBe('Claude asks: Which color theme? One, Dark. Two, Light.');
  });
});

describe('preview by voice', () => {
  const tools = (out) => new ToolRegistry()
    .add({ name: 'preview_show', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p', run: async () => out })
    .add({ name: 'code_send_message', description: 'm', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'm', run: async (a) => { sent.push(a); return { note: 'sent' }; } });
  let sent;
  const agent = (out, { task = { active: false }, last = { project: 'portfolio' } } = {}) => new Agent({ router: { chat: async () => reply('AI') }, tools: tools(out), approvals: new ApprovalQueue(), memory: { listProjects: () => [], lastTask: () => last }, tasks: { status: () => task } });

  it('"show me the homepage" answers from the preview tool, without the AI', async () => {
    sent = [];
    expect(await agent({ note: "Here's the homepage. Tap the link to open it live." }).handle('show me the homepage')).toBe("Here's the homepage. Tap the link to open it live.");
  });
  it("no project yet → the AI handles it", async () => {
    sent = [];
    expect(await agent({ note: 'x' }, { last: null }).handle('show me the homepage')).toBe('AI');
  });
  it("Novi can't run it → Claude is asked to start the site", async () => {
    sent = [];
    expect(await agent({ error: "I don't know how to run this project yet.", askClaude: true }).handle('show me the homepage')).toBe('I asked Claude to start the site. Say "show me the homepage" again in a minute.');
    expect(sent).toEqual([{ message: 'Please start the website so it can be previewed, and write .novi/run.json.' }]);
  });
});

describe('preview by voice: starting a project asks first', () => {
  it('"show me the homepage" asks "Start the portfolio site to preview it?" before running it', async () => {
    const ran = [];
    const tools = new ToolRegistry().add({
      name: 'preview_show', description: 'p', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'p',
      gate: async () => ({ approval: { title: 'Start the portfolio site to preview it?', tier: 'medium', category: 'preview', grantable: true } }),
      run: async () => { ran.push(1); return { note: "Here's the homepage." }; },
    });
    const approvals = new ApprovalQueue();
    const asked = [];
    approvals.on('added', (a) => { asked.push(a.title); approvals.resolve(a.id, true); });
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals, memory: { listProjects: () => [], lastTask: () => ({ project: 'portfolio' }) }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('show me the homepage')).toBe("Here's the homepage.");
    expect(asked).toEqual(['Start the portfolio site to preview it?']);
    expect(ran).toEqual([1]);
  });
});

describe('"open X": the project\'s site or the named editor, never a file', () => {
  const setup = () => {
    const ran = [];
    const t = (name, note) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async (a) => { ran.push([name, a]); return { note }; } });
    const tools = new ToolRegistry().add(t('preview_open', 'Opened the portfolio site.')).add(t('open_project', 'Opened portfolio in VS Code.')).add(t('file_open', 'Opened a file.'));
    const agent = new Agent({ router: { chat: async () => reply('AI') }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [], findProject: (n) => (n === 'portfolio' ? { name: 'portfolio', path: '/p' } : null) }, tasks: { status: () => ({ active: false }) } });
    return { agent, ran };
  };
  it('a known project opens its site; "in VS Code" opens the editor; anything else goes on to the AI', async () => {
    const { agent, ran } = setup();
    expect(await agent.handle('open portfolio')).toBe('Opened the portfolio site.');
    expect(await agent.handle('open portfolio in VS Code')).toBe('Opened portfolio in VS Code.');
    expect(await agent.handle('open spotify')).toBe('AI');
    expect(ran).toEqual([['preview_open', { project: 'portfolio' }], ['open_project', { project: 'portfolio', editor: 'vs code' }]]);
  });
  it('a project with no website opens in the editor; "open novi" is not run as a project', async () => {
    const ran = [];
    const t = (name, out) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async (a) => { ran.push([name, a]); return out; } });
    const tools = new ToolRegistry().add(t('preview_open', { error: "I don't know how to run this project yet.", askClaude: true })).add(t('open_project', { text: 'Opened calc-cli in VS Code.' }));
    const agent = new Agent({ router: { chat: async () => reply('AI') }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [], findProject: (n) => ({ name: n, path: `/${n}` }) }, tasks: { status: () => ({ active: false }) } });
    expect(await agent.handle('open calc-cli')).toBe('Opened calc-cli in VS Code.');
    expect(await agent.handle('open novi')).toBe('AI');
    expect(ran).toEqual([['preview_open', { project: 'calc-cli' }], ['open_project', { project: 'calc-cli' }]]);
  });
});

describe('LeetCode on the laptop', () => {
  const setup = () => {
    const opened = [];
    const tools = new ToolRegistry()
      .add({ name: 'leetcode_today', description: 'l', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'l', run: async () => ({ note: "Today's LeetCode: Two Sum (Easy).", link: 'https://leetcode.com/problems/two-sum/' }) })
      .add({ name: 'open_website', description: 'o', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'o', run: async (a) => { opened.push(a); return { opened: a.target }; } });
    const agent = new Agent({ router: { chat: async () => reply('AI') }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    return { agent, opened };
  };
  it('"… on my laptop" opens the problem there; a bare "on my laptop" after it does too', async () => {
    const { agent, opened } = setup();
    expect(await agent.handle("Show me today's LeetCode problem on my laptop.")).toBe("Today's LeetCode: Two Sum (Easy). Opened it on the laptop.");
    expect(opened).toEqual([{ target: 'https://leetcode.com/problems/two-sum/', on: 'laptop' }]);
    const b = setup();
    expect(await b.agent.handle("what's today's leetcode problem")).toBe("Today's LeetCode: Two Sum (Easy).");
    expect(await b.agent.handle('On my laptop')).toBe('Opened it on the laptop.');
    expect(b.opened).toEqual([{ target: 'https://leetcode.com/problems/two-sum/', on: 'laptop' }]);
  });
});

describe('a spoken yes for a card that needs the PIN', () => {
  // Live (2026-10-17): a plain "yes" was answered "Approved." although the PIN was still missing.
  it('says the PIN is needed instead of "Approved."', async () => {
    const { createRemoteTrust } = await import('../../server/remoteTrust.js');
    const approvals = new ApprovalQueue({ trust: createRemoteTrust({ hasPin: () => true, pin: () => false }) });
    const agent = new Agent({ router: { chat: async () => reply('AI') }, tools: new ToolRegistry(), approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    const asked = approvals.decide({ title: 'Delete the folder test 2?', tier: 'medium', source: 'novi', pin: true });
    expect(await agent.handle('yes')).toBe('That one needs your voice PIN. Say your PIN, or type it on the card.');
    expect(approvals.pending()).toHaveLength(1);
    approvals.resolve(approvals.pending()[0].id, false);
    await asked;
    const noPin = new ApprovalQueue({ trust: createRemoteTrust({ hasPin: () => false }) });
    const a2 = new Agent({ router: { chat: async () => reply('AI') }, tools: new ToolRegistry(), approvals: noPin, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    noPin.decide({ title: 'Delete it?', tier: 'medium', source: 'novi', pin: true });
    expect(await a2.handle('yes')).toBe("That one needs a voice PIN, and you haven't set one yet. Set it in Settings, then say yes again.");
  });
});

describe('deleting by voice always needs the PIN', () => {
  it('"delete the test2 folder on my desktop" goes to file_delete, and its PIN card is never skipped', async () => {
    const { fileCommand } = await import('../../server/brain/agent.js');
    expect(fileCommand('I meant delete the test2 folder.')).toEqual({ tool: 'file_delete', args: { name: 'test2' } });
    expect(fileCommand('delete the test2 folder on my desktop')).toEqual({ tool: 'file_delete', args: { name: 'test2', where: 'desktop' } });
    expect(fileCommand('delete my resume.pdf file from downloads')).toEqual({ tool: 'file_delete', args: { name: 'resume.pdf', where: 'downloads' } });
    const ran = [];
    const tools = new ToolRegistry().add({
      name: 'file_delete', description: 'd', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'd',
      gate: async () => ({ approval: { title: 'Delete the folder test2?', tier: 'medium', category: 'files', grantable: false, pin: true } }),
      run: async () => { ran.push(1); return { note: 'Deleted.' }; },
    });
    const approvals = new ApprovalQueue();
    const asked = [];
    approvals.on('added', (a) => { asked.push(a); approvals.resolve(a.id, false); });
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    agent._turnYes = new Set(['files']);
    await agent.handle('delete the test2 folder on my desktop');
    expect(asked).toHaveLength(1);
    expect(asked[0].pin).toBe(true);
    expect(ran).toEqual([]);
  });
});

describe('learned shortcuts in the agent', () => {
  it('a phrase the AI solved with one quiet tool runs straight away next time, without the AI', async () => {
    const { createShortcuts } = await import('../../server/brain/shortcuts.js');
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'novi-sca-'));
    const shortcuts = createShortcuts({ file: `${dir}/s.json` });
    const ran = [];
    const tools = new ToolRegistry().add({ name: 'open_app', description: 'o', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'o', run: async (a) => { ran.push(a); return { opened: a.name }; } });
    const router = scriptedRouter([{ message: { role: 'assistant', content: '', tool_calls: [toolCall('open_app', { name: 'Spotify' })] }, provider: 'groq', model: 'm' }, reply('Opened Spotify for you.')]);
    const agent = new Agent({ router, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, shortcuts });
    expect(await agent.handle('put on spotify')).toBe('Opened Spotify for you.');
    expect(router.calls).toHaveLength(2);
    expect(await agent.handle('Put on Spotify.')).toBe('Opened Spotify.');
    expect(router.calls).toHaveLength(2); // no AI the second time
    expect(ran).toEqual([{ name: 'Spotify' }, { name: 'Spotify' }]);
    expect(shortcuts.list()[0]).toMatchObject({ key: 'put on spotify', uses: 1 });
  });

  it('a shortcut that now fails is forgotten and the AI handles it', async () => {
    const { createShortcuts } = await import('../../server/brain/shortcuts.js');
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'novi-scb-'));
    const shortcuts = createShortcuts({ file: `${dir}/s.json` });
    shortcuts.learn('put on spotify', { tool: 'open_app', args: { name: 'Spotify' }, output: { opened: 'Spotify' } });
    const tools = new ToolRegistry().add({ name: 'open_app', description: 'o', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'o', run: async () => { throw new UserFacingError('Spotify is not installed.'); } });
    const agent = new Agent({ router: scriptedRouter([reply('Spotify is not installed on this laptop.')]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, shortcuts });
    expect(await agent.handle('put on spotify')).toBe('Spotify is not installed on this laptop.');
    expect(shortcuts.list()).toEqual([]);
  });
});

describe('activity log: what happened in each request', () => {
  it('records direct tools and AI turns; "what went wrong" answers from the log', async () => {
    const { createActivity } = await import('../../server/activity.js');
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'novi-aa-'));
    const activity = createActivity({ file: `${dir}/a.json` });
    const tools = new ToolRegistry().add({ name: 'leetcode_today', description: 'l', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'l', run: async () => ({ error: 'LeetCode is not answering right now.' }) });
    const agent = new Agent({ router: { chat: async () => reply('A joke.') }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, activity });
    await agent.handle("what's today's leetcode problem");
    await agent.handle('tell me a joke');
    const [joke, leet] = activity.list();
    expect(joke).toMatchObject({ heard: 'tell me a joke', route: 'AI (groq)', reply: 'A joke.' });
    expect(leet).toMatchObject({ route: 'direct', tools: [{ name: 'leetcode_today', ok: false, error: 'LeetCode is not answering right now.' }] });
    expect(await agent.handle('what went wrong?')).toBe('Last time I heard "tell me a joke". I answered with the AI (groq): A joke.');
    await agent.handle("what's today's leetcode problem");
    expect(await agent.handle('kya galat hua')).toBe(`Last time I heard "what's today's leetcode problem". leetcode_today failed: LeetCode is not answering right now.`);
  });
});

describe('"what\'s running?" in one answer', () => {
  const t = (name, note, extra = {}) => ({ name, description: name, parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => name, run: async () => ({ note, ...extra }) });
  const make = (status, tools) => new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => status } });

  it('the Claude task, the preview and the next reminder', async () => {
    const tools = new ToolRegistry()
      .add(t('preview_status', 'The portfolio preview is running.'))
      .add(t('reminder_list', 'You have 2 reminders: …', { items: [{ when: 'today at 6 pm', text: 'gym' }, { when: 'tomorrow', text: 'call mom' }] }));
    const status = { active: true, status: 'running', agent: 'Claude', project: 'portfolio', plan: [{ step: 'Write the homepage', doing: 'Writing the homepage', status: 'completed' }, { step: 'Add the form', doing: 'Adding the form', status: 'in_progress' }] };
    const out = await make(status, tools).handle("what's running?");
    expect(out).toMatch(/^Claude is on step 2 of 2/);
    expect(out).toContain('The portfolio preview is running.');
    expect(out).toContain('Next reminder: today at 6 pm: gym.');
  });

  it('nothing at all', async () => {
    expect(await make({ active: false }, new ToolRegistry()).handle('kya chal raha hai')).toBe('Nothing is running right now.');
  });
});

describe('understanding test dry run knows the new direct answers', () => {
  it('"what went wrong" and "what\'s running" answer without the AI', async () => {
    const { createActivity } = await import('../../server/activity.js');
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'novi-fs-'));
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools: new ToolRegistry(), approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, activity: createActivity({ file: `${dir}/a.json` }) });
    expect(await agent.firstStep('what went wrong')).toMatchObject({ provider: 'direct', reply: "I haven't done anything yet since I started." });
    expect(await agent.firstStep("what's running")).toMatchObject({ provider: 'direct', reply: 'Nothing is running right now.' });
  });
});

describe('quiet mode by voice', () => {
  it('"Novi, quiet" / "quiet for 30 minutes" / "talk again"', async () => {
    const calls = [];
    const quiet = { on: (m) => calls.push(['on', m]), off: () => calls.push(['off']), isOn: () => false, state: () => ({}) };
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools: new ToolRegistry(), approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, quiet });
    expect(await agent.handle('Novi, quiet')).toBe("Okay, I'll stay quiet. Everything will still show on screen. Say \"talk again\" when you want my voice back.");
    expect(await agent.handle('quiet for 30 minutes')).toBe("Okay, quiet for 30 minutes. Everything will still show on screen.");
    expect(await agent.handle('talk again')).toBe("Okay, I'm talking again.");
    expect(calls).toEqual([['on', null], ['on', 30], ['off']]);
  });
});

describe('quiet mode in the understanding test dry run', () => {
  it('answers without the AI and without changing anything', async () => {
    const calls = [];
    const quiet = { on: () => calls.push('on'), off: () => calls.push('off'), isOn: () => false, state: () => ({}) };
    const agent = new Agent({ router: { chat: async () => { throw new Error('no AI'); } }, tools: new ToolRegistry(), approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) }, quiet });
    expect(await agent.firstStep('Novi, quiet')).toMatchObject({ provider: 'direct', reply: 'Quiet mode on.' });
    expect(await agent.firstStep('talk again')).toMatchObject({ provider: 'direct', reply: 'Quiet mode off.' });
    expect(calls).toEqual([]);
  });
});

// Orchestrator (2026-10-18): big jobs without Claude named → a brief first; "change X" on its card.
describe('brief route', () => {
  function briefSetup({ known = ['portfolio'] } = {}) {
    const approvals = new ApprovalQueue();
    const briefs = [];
    const ran = [];
    const tools = new ToolRegistry()
      .add({ name: 'project_brief', description: 'brief', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'brief', run: async (a) => { briefs.push(a); return { note: 'Thinking it through with ChatGPT and Gemini…' }; } })
      .add({ name: 'code_start_task', description: 'start', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: (a) => `Start on ${a.project}`, run: async (a) => { ran.push(a); return { started: true, note: 'Claude is working on it.' }; } });
    const memory = { listProjects: () => known.map((name) => ({ name, path: `C:\\${name}` })), findProject: (n) => (known.includes(String(n).toLowerCase()) ? { name: n, path: `C:\\${n}` } : null) };
    const agent = new Agent({ router: scriptedRouter([]), tools, approvals, memory, tasks: { status: () => ({ active: false }), stop: async () => true } });
    return { agent, approvals, briefs, ran };
  }

  it('"let\'s work on portfolio" → project_brief with the known project, no AI', async () => {
    const { agent, briefs } = briefSetup();
    expect(await agent.handle("Let's work on portfolio and add a blog")).toBe('Thinking it through with ChatGPT and Gemini…');
    expect(briefs).toEqual([{ project: 'portfolio', request: "Let's work on portfolio and add a blog" }]);
  });

  it('an unknown name is a new project; Claude named still goes straight to Claude', async () => {
    const { agent, briefs, ran } = briefSetup();
    await agent.handle("let's work on recipe box");
    expect(briefs).toEqual([{ isNew: true, name: 'recipe box', request: "let's work on recipe box" }]);
    await agent.handle('tell Claude to add a blog to portfolio');
    expect(briefs).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it('"change X" while the brief card waits answers it with the change', async () => {
    const { agent, approvals } = briefSetup();
    const card = approvals.decide({ title: 'Send this brief to Claude?', tier: 'medium', changeable: true });
    expect(await agent.handle('change it to a blue theme')).toBe("Okay, I'm asking for that change.");
    expect(await card).toEqual({ allow: false, choice: null, change: 'a blue theme' });
  });
});

// Dictation (2026-10-18): "type …" goes straight to dictate_type, no AI.
describe('dictation route', () => {
  it('"type: see you at 5" types those words; a WhatsApp message is not dictation', async () => {
    const typed = [];
    const tools = new ToolRegistry().add({ name: 'dictate_type', description: 'type', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'type', run: async (a) => { typed.push(a); return { note: 'Typed into Notepad.' }; } });
    const agent = new Agent({ router: scriptedRouter([reply('ok')]), tools, approvals: new ApprovalQueue(), memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }), stop: async () => true } });
    expect(await agent.handle('Type: see you at 5.')).toBe('Typed into Notepad.');
    expect(typed).toEqual([{ text: 'see you at 5.' }]);
  });
});
