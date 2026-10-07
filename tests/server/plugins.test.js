import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { definePluginEntry, SEVERITY_TIER } from '../../server/plugins/sdk.js';
import { PluginHost, mapResult } from '../../server/plugins/host.js';
import { wrapRegistryAsPlugin } from '../../server/plugins/builtin.js';
import { ToolRegistry } from '../../server/tools/registry.js';

const silent = { warn() {} };
const host = (opts = {}) => new PluginHost({ logger: silent, ...opts });

const echo = ({ id = 'echo', tool = 'echo_say', hooks } = {}) => definePluginEntry({
  id,
  name: 'Echo',
  register(api) {
    api.registerTool({
      name: tool,
      description: 'Say something',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (_id, p) => ({ content: [{ type: 'text', text: `said ${p.text}` }], details: { said: p.text } }),
    });
    hooks?.(api);
  },
});

describe('definePluginEntry', () => {
  it('requires an id, a name and register()', () => {
    expect(() => definePluginEntry({ id: 'x', name: 'X' })).toThrow(/register/);
    expect(() => definePluginEntry({ name: 'X', register() {} })).toThrow(/id/);
    expect(definePluginEntry({ id: 'x', name: 'X', register() {} }).description).toBe('');
  });

  it('maps OpenClaw severities to Novi tiers', () => {
    expect(SEVERITY_TIER).toEqual({ info: 'low', warning: 'medium', critical: 'high' });
  });
});

describe('mapResult', () => {
  it('merges text content with details', () => {
    expect(mapResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], details: { x: 1 } })).toEqual({ x: 1, text: 'a\nb' });
    expect(mapResult({ details: { sensitive: true, m: [] } })).toEqual({ sensitive: true, m: [] });
    expect(mapResult(undefined)).toEqual({});
  });
});

describe('PluginHost', () => {
  it('exposes registered tools as OpenAI schemas and runs them', async () => {
    const h = host();
    expect(h.register(echo())).toBe(true);
    expect(h.schemas()).toEqual([{ type: 'function', function: { name: 'echo_say', description: 'Say something', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }]);
    expect(await h.get('echo_say').run({ text: 'hi' })).toEqual({ said: 'hi', text: 'said hi' });
    expect(h.get('nope')).toBeUndefined();
    expect(h.plugins.map((p) => p.id)).toEqual(['echo']);
  });

  it('gates nothing without hooks', async () => {
    const h = host();
    h.register(echo());
    expect(await h.get('echo_say').gate({ text: 'x' })).toEqual({});
  });

  it('turns warning/critical approvals into medium/high, info into none', async () => {
    for (const [severity, expected] of [['warning', 'medium'], ['critical', 'high'], ['info', null]]) {
      const h = host();
      h.register(echo({ hooks: (api) => api.on('before_tool_call', ({ params }) => ({ requireApproval: { title: 'Say it?', description: `Text: ${params.text}`, severity } })) }));
      const gate = await h.get('echo_say').gate({ text: 'hi' });
      if (expected) expect(gate).toEqual({ approval: { title: 'Say it?', detail: 'Text: hi', tier: expected } });
      else expect(gate).toEqual({});
    }
  });

  it('passes block results through, with optional details', async () => {
    const h = host();
    h.register(echo({ hooks: (api) => api.on('before_tool_call', () => ({ block: true, blockReason: 'Which account?', details: { ask: ['a'] } })) }));
    expect(await h.get('echo_say').gate({})).toEqual({ block: true, blockReason: 'Which account?', details: { ask: ['a'] } });
  });

  it('blocks when a hook throws', async () => {
    const h = host();
    h.register(echo({ hooks: (api) => api.on('before_tool_call', () => { throw new Error('boom'); }) }));
    expect(await h.get('echo_say').gate({})).toEqual({ block: true, blockReason: 'A plugin check failed, so Novi did not run this.' });
  });

  it('scopes hooks to their own plugin unless allTools is set', async () => {
    const h = host();
    h.register(echo());
    h.register(definePluginEntry({ id: 'nosy', name: 'Nosy', register(api) { api.on('before_tool_call', () => ({ block: true, blockReason: 'nosy' })); } }));
    expect(await h.get('echo_say').gate({})).toEqual({});
    h.register(definePluginEntry({ id: 'guard', name: 'Guard', register(api) { api.on('before_tool_call', () => ({ block: true, blockReason: 'guarded' }), { allTools: true }); } }));
    expect((await h.get('echo_say').gate({})).blockReason).toBe('guarded');
  });

  it('skips a plugin whose tool name is already taken', () => {
    const h = host();
    h.register(echo());
    expect(h.register(echo({ id: 'echo2' }))).toBe(false);
    expect(h.warnings[0]).toMatch(/echo2.*already registered by echo/);
    expect(h.plugins.map((p) => p.id)).toEqual(['echo']);
  });

  it('skips plugins with unsupported hooks or bad tools', () => {
    const h = host();
    expect(h.register(definePluginEntry({ id: 'bad', name: 'Bad', register(api) { api.on('after_everything', () => {}); } }))).toBe(false);
    expect(h.register({ id: 'worse', name: 'Worse', register(api) { api.registerTool({ name: 'x' }); } })).toBe(false);
    expect(h.warnings).toHaveLength(2);
  });

  it('gives plugins their runtime and NOVI_PLUGIN_<ID>_* config', () => {
    let seen;
    const h = host({ runtime: { speak: 'fn' }, env: { NOVI_PLUGIN_ECHO_TOKEN: 't1', OTHER: 'x' } });
    h.register(definePluginEntry({ id: 'echo', name: 'Echo', register(api) { seen = { runtime: api.runtime, config: api.pluginConfig }; } }));
    expect(seen).toEqual({ runtime: { speak: 'fn' }, config: { token: 't1' } });
  });

  it('loads plugin folders, skipping broken ones', async () => {
    // Inside the project: Vitest's loader cannot import modules from outside the project root.
    fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(path.resolve('.tmp'), 'plugins-'));
    const write = (name, manifest, code) => {
      fs.mkdirSync(path.join(dir, name));
      if (manifest !== null) fs.writeFileSync(path.join(dir, name, 'openclaw.plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      fs.writeFileSync(path.join(dir, name, 'index.js'), code);
    };
    const good = `export default { id: 'good', name: 'Good', register(api) { api.registerTool({ name: 'good_ping', description: 'ping', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'pong' }] }) }); } };`;
    write('good', { id: 'good', name: 'Good', contracts: { tools: ['good_ping'] } }, good);
    write('mismatch', { id: 'mismatch', name: 'M', contracts: { tools: ['other'] } }, good.replace(/good/g, 'mismatch'));
    write('nomanifest', null, good.replace(/good/g, 'nomanifest'));
    write('badjson', '{nope', good.replace(/good/g, 'badjson'));
    const h = host();
    await h.loadDirectory(dir);
    expect(h.plugins.map((p) => p.id)).toEqual(['good']);
    expect(await h.get('good_ping').run({})).toEqual({ text: 'pong' });
    expect(h.warnings).toHaveLength(3);
    await h.loadDirectory(path.join(dir, 'missing-dir'));
  });
});

describe('wrapRegistryAsPlugin', () => {
  function registry() {
    return new ToolRegistry()
      .add({ name: 'look', description: 'read', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'look', run: async () => ({ sensitive: true, items: [1] }) })
      .add({ name: 'send', description: 'send', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: (a) => `Send to ${a.to}`, detail: (a) => a.body, run: async (a) => ({ sent: a.to }) })
      .add({ name: 'wipe', description: 'wipe', parameters: { type: 'object', properties: {} }, tier: 'high', describe: () => 'Wipe it', run: async () => ({ wiped: true }) })
      .add({ name: 'pick', description: 'pick', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Pick', precheck: async (a) => (a.account ? null : { ask: ['x', 'y'], note: 'Which account?' }), run: async () => ({ picked: true }) });
  }

  it('keeps tiers, approval text, prechecks and outputs', async () => {
    const h = host();
    expect(h.register(wrapRegistryAsPlugin({ id: 'legacy', name: 'Legacy', registry: registry() }))).toBe(true);
    expect(await h.get('look').gate({})).toEqual({});
    expect(await h.get('look').run({})).toEqual({ sensitive: true, items: [1] });
    expect(await h.get('send').gate({ to: 'sir', body: 'Full email' })).toEqual({ approval: { title: 'Send to sir', detail: 'Full email', tier: 'medium' } });
    expect(await h.get('wipe').gate({})).toEqual({ approval: { title: 'Wipe it', detail: '', tier: 'high' } });
    expect(await h.get('pick').gate({})).toEqual({ block: true, blockReason: 'Which account?', details: { ask: ['x', 'y'], note: 'Which account?' } });
    expect(await h.get('pick').gate({ account: 'x' })).toEqual({ approval: { title: 'Pick', detail: '', tier: 'medium' } });
  });
});

describe('prompt and turn hooks (OpenClaw before_prompt_build / agent_end)', () => {
  const host = () => new PluginHost({ runtime: {}, env: {}, logger: { warn() {} } });

  it('collects system guidance and per-turn context from every plugin', async () => {
    const h = host();
    h.register({ id: 'a', name: 'A', register(api) { api.on('before_prompt_build', ({ prompt }) => ({ appendSystemContext: 'Use memory tools.', prependContext: `Facts about: ${prompt}`, sensitive: true })); } });
    h.register({ id: 'b', name: 'B', register(api) { api.on('before_prompt_build', () => ({ prependSystemContext: 'Be kind.' })); api.on('before_prompt_build', () => undefined); } });
    const ctx = await h.promptContext({ prompt: 'mom', messages: [] });
    expect(ctx.system).toBe('Use memory tools.\nBe kind.');
    expect(ctx.context).toBe('Facts about: mom');
    expect(ctx.sensitive).toBe(true);
  });

  it('a failing prompt hook is skipped, not fatal', async () => {
    const h = host();
    h.register({ id: 'a', name: 'A', register(api) { api.on('before_prompt_build', () => { throw new Error('boom'); }); } });
    expect(await h.promptContext({ prompt: 'x', messages: [] })).toEqual({ system: '', context: '', sensitive: false });
  });

  it('tells plugins about each finished turn', async () => {
    const h = host();
    const seen = [];
    h.register({ id: 'a', name: 'A', register(api) { api.on('agent_end', (e) => { seen.push(e); }); api.on('agent_end', () => { throw new Error('ignored'); }); } });
    await h.agentEnd({ messages: [{ role: 'user', content: 'hi' }], success: true });
    expect(seen).toEqual([{ messages: [{ role: 'user', content: 'hi' }], success: true }]);
  });

  it('prompt hooks do not run as tool gates', async () => {
    const h = host();
    h.register({ id: 'a', name: 'A', register(api) { api.registerTool({ name: 't', execute: async () => ({}) }); api.on('before_prompt_build', () => ({ prependContext: 'x' })); } });
    expect(await h.get('t').gate({})).toEqual({});
  });
});
