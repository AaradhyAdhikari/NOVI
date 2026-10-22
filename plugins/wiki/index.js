import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';
import { memoryDir, createVault, looksSecret } from './vault.js';
import { createActionLog } from './actions.js';
import { createNotes, words } from './notes.js';
import { createSameThings } from './sameService.js';

// Novi Memory: a Markdown folder the user can open in Obsidian (Documents\Novi Memory). Novi logs her
// own actions there automatically; notes are written and read only when the user asks.
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });

function openOnLaptop(target) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}
const obsidianOnLaptop = () => fs.existsSync(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'obsidian'));

const POINTS_BACK = /\b(?:it|that|this|those|them|same|just|again|usko|isko|wahi|wohi)\b|\bthe (?:folder|file|project|one|note)\b/i;

export function createWikiPlugin({ now = () => new Date(), env = process.env, home = os.homedir(), openPath = openOnLaptop, obsidianInstalled = obsidianOnLaptop } = {}) {
  return definePluginEntry({
    id: 'wiki',
    name: 'Novi Memory',
    description: "Novi's notes and actions log, as Markdown files in Documents\\Novi Memory (opens in Obsidian).",
    register(api) {
      const vault = createVault(memoryDir({ env, home }));
      const actions = createActionLog({ vault, now, logger: api.logger });
      const notes = createNotes({ vault, now });
      // Other plugins save into Novi Memory without the note_write card (the orchestrator's briefs).
      if (api.runtime) {
        api.runtime.wikiWrite = ({ title, text }) => ((looksSecret(text) || looksSecret(title)) ? { refused: true } : notes.write({ title, text }));
        // "portfolio brief" → "Portfolio brief" (only an all-lowercase title takes new capitals).
        api.runtime.wikiRecase = (title) => notes.recase(title);
        api.runtime.wikiRead = (title) => { const t = notes.find(title); return t ? notes.body(t).trim() : null; };
        // Every note's title and text (the second brain searches them).
        api.runtime.wikiNotes = () => notes.titles().map((t) => ({ title: t, text: notes.body(t) }));
      }
      // Same thing = one dot (user, 2026-10-20): the "Same things" note, kept up to date every 30 minutes.
      const same = createSameThings({ notes, rt: api.runtime || {}, log: (m) => api.logger?.info?.(m) });
      if (api.runtime) api.runtime.sameAliases = (name) => same.aliasesOf(name);
      let sameTimers = [];
      api.registerService({
        id: 'same-things',
        start() {
          const tick = () => same.check().catch((err) => api.logger?.info?.(`[same] ${err.message}`));
          sameTimers = [setTimeout(tick, 2 * 60_000), setInterval(tick, 30 * 60_000)];
          for (const t of sameTimers) t.unref?.();
        },
        stop() { clearTimeout(sameTimers[0]); clearInterval(sameTimers[1]); },
      });
      api.registerTool({
        name: 'same_set',
        description: 'Two names are one thing (same: true — "NOVI CONTEXT and NOVI are the same") or not (same: false — "X and Y are different"). Joins or splits their dots in Novi Memory and lets Novi find a project by either name.',
        parameters: obj({ a: str('First name'), b: str('Second name'), same: { type: 'boolean', description: 'true = the same thing, false = different' } }, ['a', 'b', 'same']),
        async execute(_id, { a, b, same: isSame } = {}) { return reply(same.set(String(a).trim(), String(b).trim(), isSame !== false)); },
      });

      api.on('after_tool_call', (event) => { actions.record(event); });
      // Only for words that point back ("it", "that", "the folder you just made", "usko"); the
      // lines hold the user's paths, so such a turn stays on the private provider.
      api.on('before_prompt_build', ({ prompt } = {}) => {
        const recent = actions.recent(5);
        if (!recent.length || !POINTS_BACK.test(String(prompt || ''))) return undefined;
        const lines = recent.map((a) => `- ${a.verb}${a.name ? ` "${a.name}"` : ''}${a.path ? ` (${a.path})` : ''}`).join('\n');
        return { appendContext: `Your recent actions (newest first) — "it", "that" and "the folder you just made" mean the newest matching one:\n${lines}`, sensitive: true };
      });

      api.registerTool({
        name: 'wiki_recent',
        description: 'What Novi did recently (newest first): folders made, files opened, renames, projects. Read-only.',
        parameters: obj({ limit: { type: 'integer', description: 'How many, default 5' } }),
        async execute(_id, { limit = 5 } = {}) {
          return reply({ actions: actions.recent(Math.min(20, Math.max(1, Number(limit) || 5))) });
        },
      });

      api.registerTool({
        name: 'note_write',
        description: 'Write something down in the user\'s notes (Novi Memory) when they ask: "note that …", "write a note about X", "add to my X note". Appends when a note with that title exists.',
        parameters: obj({ title: str('Note title (optional; default = the first words)'), text: str('What to write, in the user\'s words') }, ['text']),
        async execute(_id, { title, text }) {
          if (looksSecret(text) || looksSecret(title)) return reply({ note: "I won't save passwords or codes in notes." });
          const out = notes.write({ title, text });
          // No title given: say the words back (the title is just the first 6 — "…exam is on 5." sounded cut).
          const said = String(text).trim().replace(/[.!?]+$/, '');
          const note = !title && out.created ? `Noted: "${said.length > 140 ? `${said.slice(0, 140)}…` : said}".` : out.created ? `Saved a note: ${out.title}.` : `Added to your note ${out.title}.`;
          return reply({ ...out, note });
        },
      });

      api.registerTool({
        name: 'notes_ask',
        description: 'Answer a question from the user\'s own notes, only when they ask ("check my notes about X", "what do my notes say about X"). Names the notes it used.',
        parameters: obj({ question: str('The question') }, ['question']),
        async execute(_id, { question }) {
          const found = notes.search(question, 6);
          if (!found.length) return reply({ answer: `Your notes don't mention ${words(question).join(' ') || 'that'}.`, sources: [] });
          const context = found.map((n) => `## ${n.title}\n${n.text.slice(0, 2000)}`).join('\n\n');
          const said = await api.runtime.privateComplete(`Answer ONLY from these notes, in 2-3 sentences. If they don't cover it, say so.\nQuestion: ${question}\n\n${context}`);
          const sources = found.map((n) => n.title);
          return reply({ answer: `${String(said).trim()} From your notes: ${sources.join(', ')}.`, sources });
        },
      });

      api.registerTool({
        name: 'note_open',
        description: 'Open one of the user\'s notes (in Obsidian when installed).',
        parameters: obj({ title: str('Note title') }, ['title']),
        async execute(_id, { title }) {
          const t = notes.find(title) || notes.search(title, 1)[0]?.title;
          if (!t) return reply({ note: `I don't have a note called ${title}.` });
          const file = path.join(vault.dir, 'Notes', `${t}.md`);
          await openPath(obsidianInstalled() ? `obsidian://open?path=${encodeURIComponent(file)}` : file);
          return reply({ opened: t, note: `Opened your note ${t}.` });
        },
      });

      api.registerTool({
        name: 'notes_list',
        description: 'List the user\'s notes (titles and last change). Read-only.',
        parameters: obj({}),
        async execute() {
          return reply({ notes: vault.list('Notes').sort((a, b) => b.mtime - a.mtime).map((n) => ({ title: n.title, updated: new Date(n.mtime).toISOString().slice(0, 10) })) });
        },
      });

      api.on('before_tool_call', ({ toolName, params }) => {
        if (toolName !== 'note_write') return undefined;
        const title = params?.title || String(params?.text || '').split(/\s+/).slice(0, 6).join(' ');
        return { requireApproval: { title: `Write note ${title}`, prompt: `Write a note: ${title}.`, severity: 'warning', category: 'notes' } };
      });
    },
  });
}

export default createWikiPlugin();
