import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { LongTermMemory, localDay } from './store.js';

// Long-term memory: facts the user tells Novi (people, preferences, dates) and a daily log of
// conversations, kept in data/long-term-memory/. Everything here is private (sensitive).
const ALL_FACTS_UP_TO = 15; // a small memory goes into every turn whole; a big one only what matches
const GUIDANCE = [
  "Long-term memory: when the user tells you something lasting about themselves, people in their life, preferences, routines, important dates or decisions, call memory_remember with one short self-contained sentence (e.g. \"Mom's birthday is 12 March.\").",
  'Never store passwords, card numbers or other secrets. Use memory_recall for questions about things the user told you before, and conversation_history for "what did I ask yesterday" or "what did we talk about". Use what you remember naturally; never claim to remember something that is not in your memories.',
].join(' ');

const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ...details, sensitive: true } });

export function createMemoryPlugin({ now = () => new Date() } = {}) {
  return definePluginEntry({
    id: 'memory',
    name: 'Long-term memory',
    description: 'Remembers facts across days and keeps a searchable conversation log.',
    register(api) {
      const mem = new LongTermMemory(path.join(api.runtime.dataDir || path.resolve('data'), 'long-term-memory'), now);
      const obj = (properties, required = []) => ({ type: 'object', properties, required });
      const str = (description) => ({ type: 'string', description });

      api.on('before_prompt_build', ({ prompt }) => {
        const facts = mem.facts();
        const chosen = facts.length <= ALL_FACTS_UP_TO ? facts : mem.search(prompt, 8);
        if (!chosen.length) return { appendSystemContext: GUIDANCE };
        return {
          appendSystemContext: GUIDANCE,
          prependContext: `Things you remember about the user:\n${chosen.map((f) => `- ${f.text}`).join('\n')}`,
          sensitive: true,
        };
      });

      api.on('agent_end', ({ messages = [] }) => {
        const user = messages.find((m) => m.role === 'user')?.content;
        const novi = [...messages].reverse().find((m) => m.role === 'assistant')?.content;
        if (user && novi) mem.logExchange(String(user).slice(0, 2000), String(novi).slice(0, 2000));
      });

      api.registerTool({
        name: 'memory_remember',
        description: 'Save one lasting fact about the user (people, preferences, dates, routines, decisions) as a short self-contained sentence. Updates an older fact about the same thing.',
        parameters: obj({ fact: str('One short sentence, e.g. "Mom\'s birthday is 12 March."') }, ['fact']),
        async execute(_id, { fact }) {
          const { updated } = mem.remember(fact);
          return reply(updated ? "Got it, I've updated that." : "Okay, I'll remember that.", { remembered: fact });
        },
      });

      api.registerTool({
        name: 'memory_recall',
        description: 'Search what the user told Novi before (facts and past conversations).',
        parameters: obj({ query: str('What to look for, e.g. "mom birthday"') }, ['query']),
        async execute(_id, { query }) {
          const facts = mem.search(query);
          const past = mem.searchConversations(query, 3);
          const lines = [...facts.map((f) => f.text), ...past.map((e) => `On ${e.at.replace('T', ' at ')} the user said: "${e.user}"`)];
          return reply(lines.length ? lines.join('\n') : 'Nothing remembered about that.', { facts, conversations: past });
        },
      });

      const findOne = (query) => mem.search(query, 1)[0] || null;
      api.registerTool({
        name: 'memory_forget',
        description: 'Forget (delete) the remembered fact that best matches the description. The user approves it on screen.',
        parameters: obj({ query: str('Which memory, e.g. "mom birthday"') }, ['query']),
        async execute(_id, { query }) {
          const fact = findOne(query);
          if (!fact) return reply(`I don't have a memory about "${query}".`);
          mem.forget(fact.id);
          return reply(`Forgot: ${fact.text}`, { forgotten: fact.text });
        },
      });
      api.on('before_tool_call', ({ toolName, params }) => {
        if (toolName !== 'memory_forget') return undefined;
        const fact = findOne(params.query);
        if (!fact) return undefined;
        return { requireApproval: { title: 'Forget a memory', description: fact.text, severity: 'warning' } };
      });

      api.registerTool({
        name: 'memory_list',
        description: 'List everything Novi remembers about the user (newest first).',
        parameters: obj({}),
        async execute() {
          const facts = mem.facts().slice().reverse();
          return reply(facts.length ? `${facts.length} memories:\n${facts.slice(0, 30).map((f) => `- ${f.text}`).join('\n')}` : 'I have no memories yet.', { facts });
        },
      });

      api.registerTool({
        name: 'conversation_history',
        description: 'Past conversations with the user. date: "today", "yesterday" or YYYY-MM-DD for one day; query: words to search across all days.',
        parameters: obj({ date: str('"today", "yesterday" or YYYY-MM-DD'), query: str('Words to search for') }),
        async execute(_id, { date, query } = {}) {
          let exchanges;
          let label;
          if (query && !date) {
            exchanges = mem.searchConversations(query);
            label = `matching "${query}"`;
          } else {
            const d = now();
            const day = date === 'yesterday' ? localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1))
              : !date || date === 'today' ? localDay(d) : String(date);
            exchanges = mem.day(day).filter((e) => !query || `${e.user} ${e.novi}`.toLowerCase().includes(String(query).toLowerCase()));
            label = `on ${day}`;
          }
          if (!exchanges.length) return reply(`I found nothing ${label}.`, { exchanges });
          return reply(exchanges.slice(0, 30).map((e) => `${e.at.slice(11)} you: ${e.user} / me: ${e.novi}`).join('\n'), { exchanges });
        },
      });
    },
  });
}

export default createMemoryPlugin();
