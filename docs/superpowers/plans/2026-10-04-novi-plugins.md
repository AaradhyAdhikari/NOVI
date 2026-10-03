# Novi Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Features become OpenClaw-shaped plugins (`definePluginEntry` / `api.registerTool` / `api.on('before_tool_call')`) loaded by a `PluginHost`; built-ins are wrapped with no behaviour change; `plugins/clock` is the example.

**Architecture:** `server/plugins/sdk.js` (definePluginEntry, severity→tier), `server/plugins/host.js` (PluginHost: register, loadDirectory, ToolRegistry-compatible `schemas()/get()`, `gate()` from hooks, `mapResult`), `server/plugins/builtin.js` (`wrapRegistryAsPlugin` for existing tools). The Agent uses `tool.gate()` when present, else the old tier/precheck path.

**Tech Stack:** Node 24 ESM, Vitest. Plugins import the SDK as `#plugin-sdk` (package.json `imports`).

**Spec:** `docs/superpowers/specs/2026-10-04-novi-plugins-design.md`

## Global Constraints
- Plugin shape exactly mirrors OpenClaw: manifest `openclaw.plugin.json` with `id` and `contracts.tools`; `execute(toolCallId, params)` returns `{ content: [{type:'text', text}], details? }`; hook results `{ requireApproval: { title, description, severity } }` or `{ block, blockReason }`.
- Severity → tier: `info` → no approval, `warning` → medium, `critical` → high.
- Hooks see only their own plugin's tools unless registered with `{ allTools: true }`.
- A hook that throws blocks the call. A plugin that fails to load is skipped with a warning; Novi keeps running.
- All existing tests stay green; built-in behaviour unchanged.

## Review Focus
1. A plugin must not be able to approve or skip another plugin's approval (hooks scoped) — Task 1 test.
2. A throwing hook must block, not allow — Task 1 test.
3. Approval title/detail for wrapped Gmail send must be unchanged (full email body) — Task 1 wrapper test + existing suite.
4. Plugin tool output with `sensitive` keeps the privacy rule — Task 2 test.
5. Bad plugin folders never crash startup — Task 1 loadDirectory test.

---

### Task 1: SDK, host, built-in wrapper

**Files:** Create `server/plugins/sdk.js`, `server/plugins/host.js`, `server/plugins/builtin.js`, `tests/server/plugins.test.js`.

- [ ] Write `tests/server/plugins.test.js`:

```js
// tests/server/plugins.test.js
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-plugins-'));
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
```

- [ ] Run — FAIL (modules missing). Implement:

```js
// server/plugins/sdk.js
// Mirrors OpenClaw's `definePluginEntry` (openclaw/plugin-sdk/plugin-entry) so Novi plugins port unchanged.
export function definePluginEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('definePluginEntry needs an object');
  for (const key of ['id', 'name']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) throw new Error(`definePluginEntry needs a string "${key}"`);
  }
  if (typeof entry.register !== 'function') throw new Error('definePluginEntry needs a register(api) function');
  return Object.freeze({ description: '', ...entry });
}

// OpenClaw approval severities → Novi tiers.
export const SEVERITY_TIER = Object.freeze({ info: 'low', warning: 'medium', critical: 'high' });
```

```js
// server/plugins/host.js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { definePluginEntry, SEVERITY_TIER } from './sdk.js';

const RANK = { low: 0, medium: 1, high: 2 };
const SUPPORTED_HOOKS = new Set(['before_tool_call']);

// OpenClaw tool result → the object Novi feeds back to the model.
export function mapResult(result) {
  if (result == null) return {};
  const text = (result.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  const details = result.details && typeof result.details === 'object' ? result.details : {};
  return text ? { ...details, text } : { ...details };
}

// Loads OpenClaw-shaped plugins and serves their tools to Novi's agent.
export class PluginHost {
  constructor({ runtime = {}, env = process.env, logger = console } = {}) {
    this.runtime = runtime;
    this.env = env;
    this.logger = logger;
    this.plugins = [];
    this.tools = new Map();
    this.warnings = [];
  }

  register(rawEntry, { manifest } = {}) {
    let entry;
    const staged = [];
    const hooks = [];
    try {
      entry = definePluginEntry(rawEntry);
      const api = {
        id: entry.id,
        runtime: this.runtime,
        pluginConfig: this._configFor(entry.id),
        logger: this.logger,
        registerTool: (tool) => { staged.push(tool); },
        on: (event, handler, opts = {}) => {
          if (!SUPPORTED_HOOKS.has(event)) throw new Error(`unsupported hook "${event}"`);
          hooks.push({ handler, allTools: Boolean(opts.allTools) });
        },
      };
      entry.register(api);
      const names = new Set();
      for (const tool of staged) {
        if (!tool?.name || typeof tool.execute !== 'function') throw new Error('registerTool needs a name and an execute() function');
        if (this.tools.has(tool.name) || names.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered by ${this.tools.get(tool.name)?.pluginId || entry.id}`);
        names.add(tool.name);
      }
      if (manifest) {
        if (manifest.id !== entry.id) throw new Error(`manifest id "${manifest.id}" does not match plugin id "${entry.id}"`);
        const declared = [...(manifest.contracts?.tools || [])].sort().join(', ');
        const actual = [...names].sort().join(', ');
        if (declared !== actual) throw new Error(`manifest contracts.tools [${declared}] does not match registered tools [${actual}]`);
      }
    } catch (err) {
      this._warn(`Plugin "${rawEntry?.id || '?'}" skipped: ${err.message}`);
      return false;
    }
    this.plugins.push({ id: entry.id, name: entry.name, description: entry.description, hooks, tools: staged.map((t) => t.name) });
    for (const tool of staged) this.tools.set(tool.name, { ...tool, pluginId: entry.id });
    return true;
  }

  async loadDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const folder = path.join(dir, name);
      if (!fs.statSync(folder).isDirectory()) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'openclaw.plugin.json'), 'utf8'));
        const mod = await import(pathToFileURL(path.join(folder, 'index.js')).href);
        this.register(mod.default, { manifest });
      } catch (err) {
        this._warn(`Plugin folder "${name}" skipped: ${err.message}`);
      }
    }
  }

  // ToolRegistry-compatible view used by the Agent.
  schemas() {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      type: 'function',
      function: { name, description, parameters: parameters || { type: 'object', properties: {} } },
    }));
  }

  get(name) {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      pluginId: tool.pluginId,
      tier: 'low',
      gate: (params, ctx) => this.gate(tool, params, ctx),
      run: async (params, ctx = {}) => mapResult(await tool.execute(ctx.toolCallId || crypto.randomUUID(), params)),
    };
  }

  async gate(tool, params, { toolCallId } = {}) {
    let approval = null;
    for (const plugin of this.plugins) {
      for (const hook of plugin.hooks) {
        if (!hook.allTools && plugin.id !== tool.pluginId) continue;
        let result;
        try {
          result = await hook.handler({ toolName: tool.name, params, toolCallId });
        } catch {
          return { block: true, blockReason: 'A plugin check failed, so Novi did not run this.' };
        }
        if (!result) continue;
        if (result.block) return { block: true, blockReason: result.blockReason || 'A plugin blocked this action.', ...(result.details ? { details: result.details } : {}) };
        if (result.requireApproval) {
          const req = result.requireApproval;
          const tier = SEVERITY_TIER[req.severity || 'warning'] || 'medium';
          if (!approval || RANK[tier] > RANK[approval.tier]) approval = { title: req.title, detail: req.description || '', tier };
        }
      }
    }
    return approval && approval.tier !== 'low' ? { approval } : {};
  }

  _configFor(id) {
    const prefix = `NOVI_PLUGIN_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    const config = {};
    for (const [key, value] of Object.entries(this.env)) if (key.startsWith(prefix)) config[key.slice(prefix.length).toLowerCase()] = value;
    return config;
  }

  _warn(message) {
    this.warnings.push(message);
    this.logger.warn?.(`⚠  ${message}`);
  }
}
```

```js
// server/plugins/builtin.js
import { definePluginEntry } from './sdk.js';

// Serves an existing Novi ToolRegistry as an OpenClaw-shaped plugin:
// tools → api.registerTool, tier/describe/detail/precheck → a before_tool_call hook.
export function wrapRegistryAsPlugin({ id, name, description = '', registry }) {
  return definePluginEntry({
    id,
    name,
    description,
    register(api) {
      for (const tool of registry.tools.values()) {
        api.registerTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (_toolCallId, params) => ({ content: [], details: (await tool.run(params)) ?? {} }),
        });
      }
      api.on('before_tool_call', async ({ toolName, params }) => {
        const tool = registry.get(toolName);
        if (!tool) return undefined;
        if (tool.precheck) {
          const pre = await tool.precheck(params);
          if (pre) return { block: true, blockReason: pre.note || pre.error || 'Novi needs more information first.', details: pre };
        }
        if (tool.tier === 'low') return undefined;
        return {
          requireApproval: {
            title: tool.describe(params),
            description: tool.detail ? tool.detail(params) : '',
            severity: tool.tier === 'high' ? 'critical' : 'warning',
          },
        };
      });
    },
  });
}
```

- [ ] Run — PASS. Commit `feat: OpenClaw-shaped plugin SDK and host`.

---

### Task 2: Agent uses plugin gates

**Files:** Modify `server/brain/agent.js`. Create `tests/server/agentGate.test.js`.

- [ ] Write `tests/server/agentGate.test.js`:

```js
// tests/server/agentGate.test.js
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
```

- [ ] Run — FAIL (agent ignores `gate`). In `server/brain/agent.js` `_runTool`, replace the precheck/approval section:

```js
    if (tool.gate) {
      const gate = await tool.gate(args, { toolCallId: call.id });
      if (gate.block) return { output: { error: gate.blockReason, ...(gate.details || {}) }, note: gate.blockReason };
      if (gate.approval) {
        const allowed = await this.approvals.request({ title: gate.approval.title, detail: gate.approval.detail || '', tier: gate.approval.tier, source: 'novi' });
        if (!allowed) return { output: { error: 'The user declined this action.' } };
      }
    } else {
      if (tool.precheck) {
        const pre = await tool.precheck(args);
        if (pre) return { output: pre, note: pre.note };
      }
      if (tool.tier !== 'low') {
        const allowed = await this.approvals.request({ title: tool.describe(args), detail: tool.detail ? tool.detail(args) : '', tier: tool.tier, source: 'novi' });
        if (!allowed) return { output: { error: 'The user declined this action.' } };
      }
    }
```
  and call `tool.run(args, { toolCallId: call.id })`.

- [ ] Run agentGate + agent tests — PASS. Commit `feat: agent honours plugin approval gates`.

---

### Task 3: Example plugin `plugins/clock`

**Files:** Modify `package.json` (add `"imports": { "#plugin-sdk": "./server/plugins/sdk.js" }`). Create `plugins/clock/openclaw.plugin.json`, `plugins/clock/index.js`, `tests/server/clockPlugin.test.js`.

- [ ] Write `tests/server/clockPlugin.test.js`:

```js
// tests/server/clockPlugin.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';

describe('clock example plugin', () => {
  it('loads from plugins/ with both tools', async () => {
    const spoken = [];
    const h = new PluginHost({ runtime: { speak: (t) => spoken.push(t) }, logger: { warn() {} } });
    await h.loadDirectory(path.resolve('plugins'));
    expect(h.warnings).toEqual([]);
    expect(h.plugins.find((p) => p.id === 'clock').tools).toEqual(['clock_now', 'clock_announce']);
    const now = await h.get('clock_now').run({});
    expect(now.text.length).toBeGreaterThan(5);
    expect(now.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await h.get('clock_now').gate({})).toEqual({});
    expect(await h.get('clock_announce').gate({ message: 'Dinner is ready' })).toEqual({ approval: { title: 'Announce a message on all devices', detail: 'Dinner is ready', tier: 'medium' } });
    expect(await h.get('clock_announce').run({ message: 'Dinner is ready' })).toEqual({ announced: 'Dinner is ready', text: 'Announced.' });
    expect(spoken).toEqual(['Announcement: Dinner is ready']);
  });
});
```

- [ ] Run — FAIL. Create the plugin:

```json
{
  "id": "clock",
  "name": "Clock",
  "description": "Tells the time and can announce a message (example plugin).",
  "categories": ["other"],
  "contracts": { "tools": ["clock_now", "clock_announce"] },
  "activation": { "onStartup": true },
  "configSchema": { "type": "object", "additionalProperties": false }
}
```

```js
// plugins/clock/index.js
import { definePluginEntry } from '#plugin-sdk';

// Example Novi plugin, written in OpenClaw's plugin shape.
export default definePluginEntry({
  id: 'clock',
  name: 'Clock',
  description: 'Tells the time and can announce a message (example plugin).',
  register(api) {
    api.registerTool({
      name: 'clock_now',
      description: 'Get the current date and time on the laptop.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const now = new Date();
        const text = now.toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
        return { content: [{ type: 'text', text }], details: { iso: now.toISOString() } };
      },
    });

    api.registerTool({
      name: 'clock_announce',
      description: 'Speak a short announcement out loud on every device connected to Novi.',
      parameters: { type: 'object', properties: { message: { type: 'string', description: 'What to announce' } }, required: ['message'] },
      async execute(_toolCallId, { message }) {
        api.runtime.speak?.(`Announcement: ${message}`);
        return { content: [{ type: 'text', text: 'Announced.' }], details: { announced: message } };
      },
    });

    api.on('before_tool_call', ({ toolName, params }) => {
      if (toolName !== 'clock_announce') return undefined;
      return { requireApproval: { title: 'Announce a message on all devices', description: String(params.message || ''), severity: 'warning' } };
    });
  },
});
```

- [ ] Run — PASS. Commit `feat: clock example plugin`.

---

### Task 4: Wire the host into Novi + docs

**Files:** Modify `server/app.js`, `server/index.js`, `tests/server/app.test.js`, `README.md`. Create `docs/PLUGINS.md`.

- [ ] Add to `tests/server/app.test.js` (in `describe('Novi server')`):

```js
  it('serves built-in features as plugins', async () => {
    const { novi } = await start();
    expect(novi.plugins.plugins.map((p) => p.id)).toEqual(['coding', 'laptop', 'accounts']);
    expect(novi.tools).toBe(novi.plugins);
    expect(await novi.tools.get('gmail_send').gate({ to: 'a@b.c', subject: 's', body: 'b' })).toEqual({ block: true, blockReason: 'No Gmail account is connected yet — say "connect my Gmail".', details: { error: 'No Gmail account is connected yet — say "connect my Gmail".', note: 'No Gmail account is connected yet — say "connect my Gmail".' } });
  });
```

- [ ] Run — FAIL. In `server/app.js`:
  - imports: `ToolRegistry` from `./tools/registry.js`, `PluginHost` from `./plugins/host.js`, `wrapRegistryAsPlugin` from `./plugins/builtin.js`, `openUrl` from `./laptop/opener.js`.
  - replace the `const tools = addAccountTools(addLaptopTools(createNoviTools(...` statement with:

```js
  const plugins = new PluginHost({
    runtime: { memory, accounts, tasks, openUrl, speak: (text) => broadcast({ type: 'speak', text: plainText(text) }), logger: console },
  });
  plugins.register(wrapRegistryAsPlugin({ id: 'coding', name: 'Coding tasks', registry: createNoviTools({ memory, tasks }) }));
  plugins.register(wrapRegistryAsPlugin({ id: 'laptop', name: 'Laptop basics', registry: addLaptopTools(new ToolRegistry(), overrides.laptop) }));
  plugins.register(wrapRegistryAsPlugin({
    id: 'accounts',
    name: 'Accounts and Gmail',
    registry: addAccountTools(new ToolRegistry(), { accounts, auth, gmail, onConnected: (a) => onConnected(a), onConnectError: (e) => onConnectError(e) }),
  }));
  const tools = plugins;
```
  - return value adds `plugins`.
- [ ] In `server/index.js`, right after `const novi = createNovi(config, { lanUrls });` add:

```js
await novi.plugins.loadDirectory(path.resolve('plugins'));
```
  and in the startup log, after the Providers line:

```js
  console.log(`  Plugins: ${novi.plugins.plugins.map((p) => p.id).join(', ')}`);
```
- [ ] Write `docs/PLUGINS.md` (how to write a plugin: folder layout, manifest, `definePluginEntry`, `registerTool`, `before_tool_call` with severity table, `api.runtime` services, `api.pluginConfig` env convention, testing tip, OpenClaw mapping table, checklist). Link it from README ("Adding features").
- [ ] Run full suite — PASS; `npm run build` OK; start server → log lists `coding, laptop, accounts, clock`; ask Novi "what time is it?" → uses clock_now. Commit `feat: built-in features served as plugins; plugin guide`.
