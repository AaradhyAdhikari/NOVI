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
