import { describe, it, expect } from 'vitest';
import { Agent } from '../../server/brain/agent.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { PluginHost } from '../../server/plugins/host.js';
import { definePluginEntry } from '../../server/plugins/sdk.js';

const call = (name, args) => ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, provider = 'groq') => ({ message: { role: 'assistant', content }, provider, model: 'm' });

function setup({ steps, severity = 'warning', block = false, answer = true, details = {} }) {
  const calls = [];
  const router = { calls, chat: async (req) => { calls.push(structuredClone(req)); return steps[calls.length - 1]; } };
  const ran = [];
  const plugins = new PluginHost({ logger: { warn() {} } });
  plugins.register(definePluginEntry({
    id: 'demo',
    name: 'Demo',
    register(api) {
      api.registerTool({
        name: 'demo_do',
        description: 'do',
        parameters: { type: 'object', properties: { what: { type: 'string' } } },
        execute: async (_id, p) => { ran.push(p); return { content: [{ type: 'text', text: 'done' }], details }; },
      });
      api.on('before_tool_call', ({ params }) => (block
        ? { block: true, blockReason: 'Which account?' }
        : { requireApproval: { title: `Do ${params.what}?`, description: 'Full details here', severity } }));
    },
  }));
  const approvals = new ApprovalQueue();
  const requested = [];
  approvals.on('added', (a) => { requested.push(a); approvals.resolve(a.id, answer); });
  const agent = new Agent({ router, tools: plugins, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }), stop: async () => false } });
  return { agent, router, ran, requested };
}

describe('Agent with plugin tools', () => {
  it('asks for approval with the plugin title, detail and tier, then runs', async () => {
    const { agent, ran, requested, router } = setup({ steps: [{ message: { role: 'assistant', content: null, tool_calls: [call('demo_do', { what: 'it' })] }, provider: 'groq', model: 'm' }, reply('Done.')] });
    expect(await agent.handle('do it')).toBe('Done.');
    expect(requested[0]).toMatchObject({ title: 'Do it?', detail: 'Full details here', tier: 'medium', source: 'novi' });
    expect(ran).toEqual([{ what: 'it' }]);
    expect(JSON.parse(router.calls[1].messages.at(-1).content)).toEqual({ text: 'done' });
  });

  it('critical severity becomes a high-risk approval', async () => {
    const { agent, requested } = setup({ severity: 'critical', steps: [{ message: { role: 'assistant', content: null, tool_calls: [call('demo_do', { what: 'x' })] }, provider: 'groq', model: 'm' }, reply('ok')] });
    await agent.handle('x');
    expect(requested[0].tier).toBe('high');
  });

  it('does not run the tool when the user denies', async () => {
    const { agent, ran, router } = setup({ answer: false, steps: [{ message: { role: 'assistant', content: null, tool_calls: [call('demo_do', { what: 'x' })] }, provider: 'groq', model: 'm' }, reply('Okay.')] });
    await agent.handle('x');
    expect(ran).toEqual([]);
    expect(JSON.parse(router.calls[1].messages.at(-1).content)).toEqual({ error: 'The user declined this action.' });
  });

  it('feeds block reasons back without approval or running', async () => {
    const { agent, ran, requested, router } = setup({ block: true, steps: [{ message: { role: 'assistant', content: null, tool_calls: [call('demo_do', {})] }, provider: 'groq', model: 'm' }, reply('Which account?')] });
    expect(await agent.handle('x')).toBe('Which account?');
    expect(requested).toEqual([]);
    expect(ran).toEqual([]);
    expect(JSON.parse(router.calls[1].messages.at(-1).content)).toEqual({ error: 'Which account?' });
  });

  it('applies the privacy rule to sensitive plugin results', async () => {
    const { agent, router } = setup({ severity: 'info', details: { sensitive: true }, steps: [{ message: { role: 'assistant', content: null, tool_calls: [call('demo_do', {})] }, provider: 'gemini', model: 'g' }] });
    expect(await agent.handle('x')).toMatch(/can't read your mail right now/);
    expect(router.calls).toHaveLength(1);
  });
});
