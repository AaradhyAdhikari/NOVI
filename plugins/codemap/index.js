import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';
import { loadGraph, findNode, explain, explainText, shortestPath, pathText, summary } from './graph.js';
import { runGraphify, graphifyCommand } from './run.js';

// A code map of each project with graphify (github.com/safishamsi/graphify, Apache-2.0; user,
// 2026-10-24: "use graphify in novi and for novi"). `graphify update` reads the code without AI;
// Novi answers "how does X connect to Y" / "explain the X class" from graph.json itself (ms, no AI),
// shows the interactive graph.html, and refreshes a mapped project after each coding task so Claude
// (told in its system prompt to read graphify-out/GRAPH_REPORT.md first) opens fewer files.
const OUT = 'graphify-out';
const mapFile = (folder) => path.join(folder, OUT, 'graph.json');
const pageFile = (folder) => path.join(folder, OUT, 'graph.html');
const hasMap = (folder) => Boolean(folder) && fs.existsSync(mapFile(folder));

// A git project gets graphify-out/ in its .gitignore once (the map lists every file and function).
function keepOffGit(folder) {
  if (!fs.existsSync(path.join(folder, '.git'))) return false;
  const file = path.join(folder, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\/?graphify-out\/?\s*$/m.test(text)) return false;
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${OUT}/\n`);
  return true;
}

const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// graph.html in the laptop's default browser. Live (2026-10-24): a file:// link through url.dll
// opened nothing (the ドキュメント folder in the path); explorer.exe with the plain path works.
// Not windowsHide: that starts the window hidden.
function openOnLaptop(file) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

export function createCodemapPlugin({ run = null, track = () => {}, openFile = openOnLaptop } = {}) {
  return definePluginEntry({
    id: 'codemap',
    name: 'Code map',
    description: 'A map of how a project\'s code fits together (graphify, no AI): explain a part, how two parts connect, show the graph.',
    register(api) {
      const rt = api.runtime || {};
      const build = run || ((folder) => runGraphify(folder, { command: graphifyCommand(api.pluginConfig?.command) }));
      const building = new Map(); // folder → promise
      const cache = new Map(); // folder → { mtime, graph }

      const graphOf = (folder) => {
        const mtime = fs.statSync(mapFile(folder)).mtimeMs;
        const hit = cache.get(folder);
        if (hit?.mtime === mtime) return hit.graph;
        const graph = loadGraph(JSON.parse(fs.readFileSync(mapFile(folder), 'utf8')));
        cache.set(folder, { mtime, graph });
        return graph;
      };
      // A name Novi only has in lowercase ("novi") is said the way the user said it ("Novi").
      const projectOf = (name) => {
        const p = rt.codingProject?.(name || undefined);
        if (!p?.path) return null;
        const said = String(name || '').trim();
        return p.name === p.name.toLowerCase() && said.toLowerCase() === p.name ? { ...p, name: said } : p;
      };
      const reply = (details) => ({ content: [], details });
      const noMap = (p) => reply({ unknown: true, error: `${p.name} has no code map yet. Say "map the ${p.name} code" to make one.` });

      // One build per folder at a time; `quiet` = the refresh after a coding task (nothing said).
      const refresh = (p, { quiet = false } = {}) => {
        if (building.has(p.path)) return building.get(p.path);
        const job = (async () => {
          const added = keepOffGit(p.path);
          const res = await build(p.path);
          if (!res.ok) {
            api.logger?.warn?.(`[codemap] ${p.name}: ${res.error}`);
            if (!quiet) rt.say?.(`I couldn't map ${p.name}: ${res.error}`, { kind: null });
            return;
          }
          if (quiet) return;
          const s = summary(graphOf(p.path));
          const extra = added ? ` (I added ${OUT}/ to .gitignore so the map stays off GitHub.)` : '';
          rt.say?.(`Mapped ${p.name}: ${s.parts} parts and ${s.links} links. The most connected: ${list(s.hubs)}.${extra}`, { kind: null });
        })().catch((err) => api.logger?.warn?.(`[codemap] ${err.message}`)).finally(() => building.delete(p.path));
        building.set(p.path, job);
        track(job);
        return job;
      };

      api.registerTool({
        name: 'codemap_build',
        description: 'Make or refresh the code map of a project with graphify (no AI): "map the Novi code", "update the code map of X". Runs in the background and says when done.',
        parameters: { type: 'object', properties: { project: { type: 'string', description: 'Project name; empty = the current coding project' } } },
        async execute(_id, { project } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ error: project ? `I don't know a project called ${project}.` : 'Which project should I map?' });
          if (building.has(p.path)) return reply({ note: `Already mapping ${p.name}'s code.` });
          refresh(p);
          return reply({ note: `Mapping ${p.name}'s code (no AI, up to a few minutes for a big project). I'll tell you when it's done.` });
        },
      });

      api.registerTool({
        name: 'codemap_ask',
        description: 'Answer from a project\'s code map (no AI): explain one part of the code ("explain the ApprovalQueue class", "what uses X") or how two parts connect ("how does the orchestrator connect to the task manager").',
        parameters: {
          type: 'object',
          properties: {
            part: { type: 'string', description: 'The class / function / file to explain, or the start of the connection' },
            to: { type: 'string', description: 'The other part, to find how they connect' },
            project: { type: 'string', description: 'Project name; empty = the current coding project' },
            users: { type: 'boolean', description: 'true = only what uses this part ("what uses X")' },
          },
          required: ['part'],
        },
        async execute(_id, { part, to, project, users = false } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ unknown: true, error: project ? `I don't know a project called ${project}.` : 'Which project is that in?' });
          if (!hasMap(p.path)) return noMap(p);
          const g = graphOf(p.path);
          const a = findNode(g, part);
          if (!a) return reply({ unknown: true, error: `I couldn't find "${part}" in ${p.name}'s code map.` });
          if (!to) return reply({ note: explainText(explain(g, a.id, { users })), sensitive: true });
          const b = findNode(g, to);
          if (!b) return reply({ unknown: true, error: `I couldn't find "${to}" in ${p.name}'s code map.` });
          const way = shortestPath(g, a.id, b.id);
          return reply({ note: way ? pathText(g, way) : `${a.label} and ${b.label} aren't connected in ${p.name}'s code (within 8 steps).`, sensitive: true });
        },
      });

      api.registerTool({
        name: 'codemap_show',
        description: 'Show the interactive code map of a project ("show me the Novi code map"): opens it in the laptop browser, or a link on the phone.',
        parameters: { type: 'object', properties: { project: { type: 'string', description: 'Project name; empty = the current coding project' } } },
        async execute(_id, { project } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ error: project ? `I don't know a project called ${project}.` : 'Which project\'s code map?' });
          if (!fs.existsSync(pageFile(p.path))) return noMap(p);
          if ((rt.deviceHost?.() || 'localhost') === 'localhost') {
            openFile(pageFile(p.path));
            return reply({ note: `Opened ${p.name}'s code map in the browser.` });
          }
          rt.showLink?.({ url: rt.fileLink(pageFile(p.path), { inline: true }), label: `${p.name}'s code map` });
          return reply({ note: `Here's ${p.name}'s code map. Tap the link to open it.` });
        },
      });

      // The first map adds a folder (and a .gitignore line) to the project: asked once, unless the
      // user's own words named it (direct). Refreshing an existing map never asks.
      api.on('before_tool_call', async ({ toolName, params }) => {
        if (toolName !== 'codemap_build') return null;
        const p = projectOf(params?.project);
        if (!p || hasMap(p.path)) return null;
        const title = `Make a code map of ${p.name}?`;
        return { requireApproval: { title, prompt: title, description: `Adds a ${OUT} folder there (no AI).`, severity: 'warning', category: 'files', grantable: true } };
      });

      // After Claude (or Novi Coder) finishes on a mapped project, the map catches up quietly.
      const seen = new Set();
      rt.tasks?.on?.('task', (task) => {
        if (task?.status !== 'done' || !task.path || !hasMap(task.path)) return;
        const key = `${task.id || task.startedAt || ''}:${task.path}`;
        if (seen.has(key)) return;
        seen.add(key);
        refresh({ name: task.project, path: task.path }, { quiet: true });
      });
    },
  });
}

export default createCodemapPlugin();
