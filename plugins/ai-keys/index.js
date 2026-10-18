import { definePluginEntry } from '#plugin-sdk';

// "Which AI keys are missing?" (user, 2026-10-18: "make Novi not stall"): each free AI provider with
// how many keys it has — never the keys themselves. More providers = more fallbacks when one is busy.
const ENV = (name) => `${name.toUpperCase()}_API_KEYS`;

export function keysNote(list) {
  const have = list.filter((k) => k.keys > 0);
  const missing = list.filter((k) => !k.keys);
  const haveText = have.length ? `You have keys for ${have.map((k) => `${k.name} (${k.keys})`).join(', ')}.` : "You don't have any AI keys yet.";
  if (!missing.length) return `${haveText} Every free AI provider Novi knows has a key.`;
  return `${haveText} Missing: ${missing.map((k) => k.name).join(', ')}. Add them to .env as ${missing.map((k) => `${ENV(k.name)}=…`).join(', ')}, then restart Novi.`;
}

export default definePluginEntry({
  id: 'ai-keys',
  name: 'AI keys check',
  description: 'Which free AI providers have keys in .env, and which are missing (never the keys).',
  register(api) {
    api.registerTool({
      name: 'ai_keys_status',
      description: 'Which AI providers have API keys and which free ones are missing ("which AI keys are missing", "check my API keys"). Never shows a key.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const list = api.runtime?.aiKeys?.() || [];
        return { content: [], details: { providers: list, note: keysNote(list) } };
      },
    });
  },
});
