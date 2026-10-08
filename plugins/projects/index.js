import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { definePluginEntry } from '#plugin-sdk';
import { gatherSources } from './sources.js';

// "What's next on NOVI?" / "where did I leave off?": a short summary of a project from its own
// commits, notes, newest plan and TODOs. Summarised by the private AI only (project details are
// private); cached until the project changes. Opening the project in an editor gets a one-time
// "last time on…" per day.
const EDITORS = /visual studio code|cursor|antigravity|kiro/i;
export const matchesProject = (title, name) => EDITORS.test(title) && String(title).toLowerCase().includes(String(name).toLowerCase());
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ...details, sensitive: true } });
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const safe = (name) => String(name).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);

function fallback(s) {
  const last = s.commits[0] ? `Last time: ${s.commits[0]}.` : 'No recent commits.';
  const open = s.openItems.length ? ` Still open: ${s.openItems.slice(0, 3).join('; ')}.` : s.todos.length ? ` Still open: ${s.todos.length} TODOs in the code.` : '';
  return `${last}${open}`;
}

function prompt(name, s) {
  return [
    `Summarise where the user left off on their project "${name}" in at most 2 short spoken sentences:`,
    '"Last time you … Still open: …" (at most 3 open items, plain words, no markdown, no file paths).',
    `Recent commits (newest first): ${s.commits.slice(0, 10).join(' | ') || 'none'}`,
    `Open plan items: ${s.openItems.join(' | ') || 'none'}`,
    `TODOs: ${s.todos.slice(0, 8).join(' | ') || 'none'}`,
    `Novi's last coding tasks: ${s.lastTasks.join(' | ') || 'none'}`,
    `Project notes (excerpt): ${s.notes.slice(0, 1500)}`,
  ].join('\n');
}

// gather / activeWindow / onCheck: injectable for tests.
export function createProjectsPlugin({ gather = gatherSources, now = () => new Date(), activeWindow = null, tickMs = 30_000, onCheck = null } = {}) {
  return definePluginEntry({
    id: 'projects',
    name: 'Where you left off',
    description: '"What\'s next on <project>?" and a "last time on…" note when you open it.',
    register(api) {
      const dir = path.join(api.runtime.dataDir || path.resolve('data'), 'projects');
      const projects = () => api.runtime.memory?.listProjects?.() || [];
      const tasks = () => api.runtime.memory?.listTasks?.() || [];

      function pick(requested) {
        const all = projects();
        if (requested) {
          const q = String(requested).toLowerCase();
          const found = all.find((p) => p.name.toLowerCase() === q) || all.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
          if (!found) throw new Error(`I don't know a project called "${requested}". Say "remember my project …" first.`);
          return found;
        }
        const lastTask = tasks().find((t) => t.project);
        return (lastTask && all.find((p) => p.name === lastTask.project)) || [...all].sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')))[0] || null;
      }

      async function summary(project) {
        const s = await gather({ dir: project.path, tasks: tasks().filter((t) => t.project === project.name) });
        const key = `${s.head || 'nogit'}:${crypto.createHash('sha1').update(JSON.stringify(s)).digest('hex')}`;
        const file = path.join(dir, `${safe(project.name)}.json`);
        try {
          const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (cached.key === key) return cached.text;
        } catch { /* not cached yet */ }
        let text;
        try {
          text = String(await api.runtime.privateComplete(prompt(project.name, s))).trim() || fallback(s);
        } catch {
          return fallback(s); // private AI busy: don't cache, don't use another provider
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ key, text, at: now().toISOString() }));
        return text;
      }

      api.registerTool({
        name: 'project_next',
        description: 'Where the user left off on a project and what is still open ("what\'s next on NOVI?", "where did I leave off?"). project: name, default = the last one worked on.',
        parameters: { type: 'object', properties: { project: { type: 'string' } } },
        async execute(_id, { project } = {}) {
          const p = pick(project);
          if (!p) return reply('I don\'t know any of your projects yet. Say "remember my project …" with its folder.');
          return reply(await summary(p), { project: p.name });
        },
      });

      // Opening a project in an editor: "Last time on NOVI: …", once per project per day.
      const noticed = new Map();
      async function checkOpen() {
        let title = '';
        try { title = String((await (activeWindow || api.runtime.activeWindowTitle)?.()) || ''); } catch { return; }
        const p = projects().find((x) => matchesProject(title, x.name));
        if (!p) return;
        const today = dayOf(now());
        if (noticed.get(p.name) === today) return;
        noticed.set(p.name, today);
        try {
          // On the laptop (where the editor is), no phone notification.
          api.runtime.say?.(`Last time on ${p.name}: ${await summary(p)}`, { kind: null, local: true });
        } catch { /* the notice is a nicety */ }
      }
      onCheck?.(checkOpen);
      let timer = null;
      api.registerService({
        start: () => { timer = setInterval(checkOpen, tickMs); timer.unref?.(); },
        stop: () => clearInterval(timer),
      });
    },
  });
}

export default createProjectsPlugin();
