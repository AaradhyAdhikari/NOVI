import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { openStore, sqliteAvailable } from './store.js';
import { createIngest } from './ingest.js';
import { searchBrain, contextFor } from './search.js';

// Novi's second brain, Part 1 (2026-10-18, spec docs/superpowers/specs/2026-10-18-novi-second-brain-design.md):
// every file and folder by name, the words inside every readable file, projects and notes in one SQLite
// file; each AI turn about the user's own things gets only the few passages it needs.
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const OFF = 'The second brain needs Node 22.5 or newer. Update Node on the laptop, then restart Novi.';

export function createBrainPlugin({ dbFile = null, autoStart = true, syncEveryMs = 15 * 60_000, readEveryMs = 1500, batch = 4 } = {}) {
  return definePluginEntry({
    id: 'brain',
    name: 'Second brain',
    description: 'Every file, folder, project and note on the laptop in one searchable brain; AI turns get only the evidence they need.',
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(m);
      const on = sqliteAvailable();
      let store = null;
      let ingest = null;
      const ready = () => {
        if (!on) return false;
        if (store) return true;
        store = openStore(dbFile || path.join(rt.dataDir || '.', 'brain', 'brain.db'));
        ingest = createIngest({
          store,
          entries: () => rt.fileEntries?.() || [],
          readText: (p) => rt.readFileText(p),
          projects: () => rt.projects?.list?.() || [],
          notes: () => rt.wikiNotes?.() || [],
          skipDirs: [rt.dataDir].filter(Boolean),
          log,
        });
        return true;
      };
      let reading = false;
      async function readAll() {
        if (reading) return;
        reading = true;
        try { while (await ingest.readSome(50)) { /* until everything is read */ } } finally { reading = false; }
      }
      if (api.runtime) api.runtime.brainSync = async () => { if (!ready()) return; await ingest.syncAll(); await readAll(); };
      const projectNames = () => (rt.projects?.list?.() || []).flatMap((p) => [p.name, p.path && path.basename(p.path)]).filter(Boolean);

      api.registerService({
        id: 'brain',
        async start() {
          if (!autoStart) return;
          if (!ready()) { log(`[brain] ${OFF}`); return; }
          const sync = () => ingest.syncAll().catch((err) => log(`[brain] sync failed: ${err.message}`));
          // Reading runs a few files at a time so Novi stays quick while the brain fills.
          const step = async () => {
            try { await ingest.readSome(batch); } catch (err) { log(`[brain] read failed: ${err.message}`); }
            setTimeout(step, readEveryMs).unref?.();
          };
          setTimeout(() => { sync().then(step); }, 20_000).unref?.();
          if (syncEveryMs > 0) setInterval(sync, syncEveryMs).unref?.();
        },
      });

      api.registerTool({
        name: 'brain_search',
        description: "Search the user's second brain: every file and folder on the laptop (and the words inside readable ones), their projects and notes. For \"where is my…\", \"which file has…\", \"what did I write about…\". Read-only.",
        parameters: obj({ query: { type: 'string', description: 'What to look for' }, project: { type: 'string', description: 'Only this project (optional)' } }, ['query']),
        async execute(_id, { query, project } = {}) {
          if (!ready()) return reply({ error: OFF });
          const results = searchBrain(store, query, { project: project ? String(project).toLowerCase() : null, limit: 8 })
            .map(({ kind, title, path: p, project: pr, snippet }) => ({ kind, title, path: p, project: pr, snippet: snippet.slice(0, 160) }));
          return reply({ results, note: results.length ? null : `Nothing in your brain matches "${query}".` });
        },
      });

      api.registerTool({
        name: 'brain_status',
        description: 'How much of the laptop the second brain knows and has read.',
        parameters: obj({}),
        async execute() {
          if (!ready()) return reply({ error: OFF });
          const s = store.stats();
          const pending = s.pending ? ` Still reading ${n(s.pending, 'file', 'files')}.` : '';
          return reply({ ...s, note: `I know ${n(s.files + s.folders, 'file and folder', 'files and folders')}, ${n(s.projects, 'project', 'projects')} and ${n(s.notes, 'note', 'notes')}; I've read inside ${n(s.read, 'file', 'files')}.${pending}` });
        },
      });

      // The design rule: only the evidence this request needs, never the whole brain. Private → Groq.
      api.on('before_prompt_build', ({ prompt } = {}) => {
        if (!ready()) return undefined;
        try {
          const ctx = contextFor(store, prompt, { projects: projectNames() });
          return ctx.text ? { appendContext: ctx.text, sensitive: true } : undefined;
        } catch (err) { log(`[brain] context failed: ${err.message}`); return undefined; }
      });
    },
  });
}

export default createBrainPlugin();
