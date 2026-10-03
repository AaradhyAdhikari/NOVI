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
