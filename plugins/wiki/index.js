import os from 'node:os';
import { definePluginEntry } from '#plugin-sdk';
import { memoryDir, createVault } from './vault.js';
import { createActionLog } from './actions.js';

// Novi Memory: a Markdown folder the user can open in Obsidian (Documents\Novi Memory). Novi logs her
// own actions there automatically; notes are written and read only when the user asks.
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

export function createWikiPlugin({ now = () => new Date(), env = process.env, home = os.homedir() } = {}) {
  return definePluginEntry({
    id: 'wiki',
    name: 'Novi Memory',
    description: "Novi's notes and actions log, as Markdown files in Documents\\Novi Memory (opens in Obsidian).",
    register(api) {
      const vault = createVault(memoryDir({ env, home }));
      const actions = createActionLog({ vault, now, logger: api.logger });

      api.on('after_tool_call', (event) => { actions.record(event); });
      api.on('before_prompt_build', () => {
        const recent = actions.recent(5);
        if (!recent.length) return undefined;
        const lines = recent.map((a) => `- ${a.verb}${a.name ? ` "${a.name}"` : ''}${a.path ? ` (${a.path})` : ''}`).join('\n');
        return { appendSystemContext: `Your recent actions (newest first) — "it", "that" and "the folder you just made" mean the newest matching one:\n${lines}` };
      });

      api.registerTool({
        name: 'wiki_recent',
        description: 'What Novi did recently (newest first): folders made, files opened, renames, projects. Read-only.',
        parameters: obj({ limit: { type: 'integer', description: 'How many, default 5' } }),
        async execute(_id, { limit = 5 } = {}) {
          return reply({ actions: actions.recent(Math.min(20, Math.max(1, Number(limit) || 5))) });
        },
      });
    },
  });
}

export default createWikiPlugin();
