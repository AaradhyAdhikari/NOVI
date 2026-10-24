// The notes galaxy (Settings → Memory): every Markdown file in the vault is a dot, [[links]] and
// plain mentions of another note's title are lines. The daily Actions files are one "Actions" dot.
import fs from 'node:fs';
import path from 'node:path';
import { parseSame, mainName, isContainerName } from './same.js';
import { loadGraph, summary } from '../codemap/graph.js'; // pure reader of graphify's graph.json

const EXCERPT = 200;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripFront = (text) => String(text || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
const plain = (text) => stripFront(text).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, alias) => alias || t)
  .replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();

// Top-level .md files and those one folder down (Notes/, Actions/, folders the user makes in Obsidian).
function files(vault) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(vault.dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // .obsidian, .trash
    if (e.isFile() && e.name.endsWith('.md')) out.push({ id: e.name, folder: '', title: e.name.slice(0, -3) });
    if (e.isDirectory()) {
      for (const f of vault.list(e.name)) out.push({ id: `${e.name}/${f.title}.md`, folder: e.name, title: f.title, mtime: f.mtime });
    }
  }
  return out;
}

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

export function buildGraph(vault) {
  const all = files(vault);
  const actions = all.filter((f) => f.folder === 'Actions').sort((a, b) => b.title.localeCompare(a.title));
  const notes = all.filter((f) => f.folder !== 'Actions').map((f) => {
    const text = vault.read(f.id) || '';
    return { ...f, text, updated: (stripFront(text) !== text && /^updated: (.+)$/m.exec(text)?.[1]) || day(f.mtime ?? safeMtime(vault, f.id)) };
  });
  const nodes = notes.map((n) => ({ id: n.id, title: n.title, folder: n.folder || 'Home', updated: n.updated, excerpt: plain(n.text).slice(0, EXCERPT) }));
  if (actions.length) {
    nodes.push({ id: 'Actions', title: 'Actions', folder: 'Actions', updated: actions[0].title, excerpt: `What Novi did on ${actions.length} day${actions.length === 1 ? '' : 's'}. Latest: ${plain(vault.read(actions[0].id)).slice(0, 150)}`.slice(0, EXCERPT) });
  }

  const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
  const seen = new Set();
  const links = [];
  const add = (a, b) => {
    if (!b || a === b) return;
    const key = [a, b].sort().join('\n');
    if (!seen.has(key)) { seen.add(key); links.push({ source: a, target: b }); }
  };
  for (const n of notes) {
    const body = stripFront(n.text);
    for (const m of body.matchAll(/\[\[([^\]|#]+)/g)) add(n.id, byTitle.get(path.basename(m[1].trim()).toLowerCase()));
    for (const other of nodes) {
      if (other.id === n.id || other.title.length < 3) continue;
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escape(other.title)}(?![\\p{L}\\p{N}])`, 'iu').test(body)) add(n.id, other.id);
    }
  }
  // One group per project (user, 2026-10-18): "X project" hangs off Novi Memory; "X brief" and every
  // other note named "X …", plus the project's README, logo and pictures, hang off "X project".
  const hub = nodes.find((n) => n.id === 'Novi Memory.md')?.id;
  // One dot per thing (user, 2026-10-20): names the "Same things" note joins are one project, shown with
  // the shortest clean name; the other notes' dots fold into it. A Documents-like folder is no project.
  const sameNote = notes.find((n) => n.title.toLowerCase() === 'same things');
  const same = parseSame(sameNote ? stripFront(sameNote.text) : '');
  const mainOf = new Map();
  for (const g of same.groups) { const m = mainName(g); for (const n of g) mainOf.set(n.toLowerCase(), m); }
  const nameOf = (p) => p.title.replace(/ project$/i, '').trim();
  const dropped = new Map(); // folded or removed note id → the dot it became (null = gone)
  const byMain = new Map();
  for (const p of notes.filter((n) => / project$/i.test(n.title))) {
    if (!/[\p{L}\p{N}]/u.test(nameOf(p)) || isContainerName(nameOf(p))) { dropped.set(p.id, null); continue; }
    const main = mainOf.get(nameOf(p).toLowerCase()) || nameOf(p);
    byMain.set(main.toLowerCase(), [...(byMain.get(main.toLowerCase()) || []), { p, main }]);
  }
  const aliases = new Map(); // project note id → every name it goes by
  const projects = [...byMain.values()].map((group) => {
    const main = group[0].main;
    const keep = (group.find((x) => nameOf(x.p).toLowerCase() === main.toLowerCase()) || group[0]).p;
    for (const { p } of group) if (p !== keep) dropped.set(p.id, keep.id);
    const node = nodes.find((n) => n.id === keep.id);
    node.title = `${main} project`;
    const names = [main, ...group.map((x) => nameOf(x.p)), ...(same.groups.find((g) => g.some((n) => n.toLowerCase() === main.toLowerCase())) || [])];
    aliases.set(keep.id, [...new Set(names.map((n) => n.toLowerCase()))]);
    return { ...keep, title: `${main} project`, text: group.map((x) => x.p.text).join('\n\n') };
  });
  // Projects on claude.ai hang off one "Claude" dot (user, 2026-10-20: "easy for Novi to find them").
  const onClaude = projects.filter((p) => /^On claude\.ai: /m.test(stripFront(p.text)));
  // ChatGPT plans, Claude builds (user, 2026-10-20). The "ChatGPT" dot holds the user's ChatGPT projects
  // ("On ChatGPT:" in "X project", unless a later "No longer on ChatGPT:"), pinned chats ("X (pinned chat)"
  // until "Unpinned on ChatGPT:"), the planning chat note ("ChatGPT plan") and every "X brief".
  const lastOf = (text, re) => [...stripFront(text).matchAll(re)].pop()?.[1];
  const onChatGPT = projects.filter((p) => lastOf(p.text, /^(On ChatGPT|No longer on ChatGPT): /gm) === 'On ChatGPT');
  const pinned = notes.filter((n) => / \(pinned chat\)$/i.test(n.title) && lastOf(n.text, /^(Pinned|Unpinned) on ChatGPT: /gm) === 'Pinned');
  const plan = notes.find((n) => n.title.toLowerCase() === 'chatgpt plan');
  const briefs = notes.filter((n) => / brief$/i.test(n.title));
  const hasChatGPT = Boolean(onChatGPT.length || pinned.length || plan || briefs.length);
  const counted = (list, one, many, strip) => (list.length ? `${list.length} ${list.length === 1 ? one : many} (${list.map((n) => n.title.replace(strip, '')).join(', ')})` : null);
  const and = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]);
  if (onClaude.length || hasChatGPT) {
    const names = onClaude.map((p) => p.title.replace(/ project$/i, ''));
    const excerpt = names.length ? `Your ${names.length} project${names.length === 1 ? '' : 's'} on claude.ai: ${names.join(', ')}` : 'Claude builds what ChatGPT plans.';
    nodes.push({ id: 'Claude', title: 'Claude', folder: 'Claude', updated: null, excerpt: excerpt.slice(0, EXCERPT) });
    add('Claude', hub);
  }
  if (hasChatGPT) {
    const parts = [counted(onChatGPT, 'project', 'projects', / project$/i), counted(pinned, 'pinned chat', 'pinned chats', / \(pinned chat\)$/i),
      plan && 'your planning chat (ChatGPT plan)', counted(briefs, 'project brief', 'project briefs', / brief$/i)].filter(Boolean);
    nodes.push({ id: 'ChatGPT', title: 'ChatGPT', folder: 'ChatGPT', updated: null, excerpt: `On ChatGPT: ${and(parts)}. Claude builds them.`.slice(0, EXCERPT) });
    add('ChatGPT', hub);
    add('ChatGPT', 'Claude'); // they work together (user, 2026-10-20: "make a direct relationship")
    if (plan) add(plan.id, 'Claude'); // the plan is what Claude builds (user, 2026-10-20)
    for (const n of [...pinned, ...briefs, ...(plan ? [plan] : [])]) add(n.id, 'ChatGPT');
  }
  for (const p of projects) {
    const hubs = [onClaude.includes(p) && 'Claude', onChatGPT.includes(p) && 'ChatGPT'].filter(Boolean);
    for (const h of hubs.length ? hubs : [hub]) add(p.id, h);
    const name = p.title.replace(/ project$/i, '');
    // "X brief", "X (pinned chat)", any "X …" — under any name the project goes by.
    for (const n of notes) if (n.id !== p.id && !dropped.has(n.id) && aliases.get(p.id).some((a) => n.title.toLowerCase().startsWith(`${a} `))) add(n.id, p.id);
    // The newest `Folder:` line (a folder linked later wins), plus any `Context:` folders.
    const body = stripFront(p.text);
    const folder = [...body.matchAll(/^Folder: (.+)$/gm)].pop()?.[1]?.trim();
    const contexts = [...body.matchAll(/^Context: (.+)$/gm)].map((m) => m[1].trim()).filter((c) => c !== folder && isDirectory(c));
    const dots = projectDots(folder, name);
    for (const c of contexts) dots.push(...projectDots(c, name).filter((d) => d.title !== 'Context' || !dots.some((x) => x.title === 'Context')));
    for (const d of dots) {
      if (nodes.some((x) => x.id === d.id)) continue;
      nodes.push({ ...d, folder: 'Project files', excerpt: d.excerpt.slice(0, EXCERPT) });
      add(d.id, p.id);
    }
  }
  // A note linked to nothing still belongs to Novi Memory instead of floating alone.
  const linked = new Set(links.flatMap((l) => [l.source, l.target]));
  for (const n of nodes) if (!linked.has(n.id)) add(n.id, hub);
  // Folded notes' lines move to the dot they became; removed ones (and lines to themselves) go.
  const kept = nodes.filter((n) => !dropped.has(n.id));
  const moved = new Map();
  for (const l of links) {
    const a = dropped.has(l.source) ? dropped.get(l.source) : l.source;
    const b = dropped.has(l.target) ? dropped.get(l.target) : l.target;
    if (a && b && a !== b) moved.set([a, b].sort().join('\n'), { source: a, target: b });
  }
  return { nodes: kept, links: [...moved.values()] };
}

const IMAGE = /\.(png|jpe?g|svg|webp|gif|ico)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.next', 'coverage', 'vendor', '.venv', 'venv', 'graphify-out']);

// plugins/codemap's map (graphify-out/graph.json), summed up the way the codemap plugin says it
// (graphify's own report counts tests, packages and doc headings — live, "vitest" topped it).
// Read again only when the map changes.
const mapSummaries = new Map(); // folder → { mtime, s }
function codeMapDot(folder, name) {
  const file = path.join(folder, 'graphify-out', 'graph.json');
  const mtime = safeStat(file);
  if (mtime == null) return null;
  let s = mapSummaries.get(folder)?.mtime === mtime ? mapSummaries.get(folder).s : null;
  if (!s) {
    try { s = summary(loadGraph(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { return null; }
    mapSummaries.set(folder, { mtime, s });
  }
  const list = s.hubs.length < 2 ? s.hubs.join('') : `${s.hubs.slice(0, -1).join(', ')} and ${s.hubs.at(-1)}`;
  const said = `${s.parts} parts and ${s.links} links.${s.hubs.length ? ` The most connected: ${list}.` : ''}`;
  return { id: `codemap:${folder}`, title: 'Code map', updated: day(mtime), excerpt: `${said} Say "show me the ${name} code map" to open it, or ask "how does X connect to Y".` };
}

// A project's folder as a few simple dots (user, 2026-10-18: "why so many different icons… make
// everything simple"): Context (the README), Pictures (one dot; icon-32/icon-192/… count once), Files,
// and Code map once plugins/codemap mapped it (2026-10-24).
export function projectDots(folder, name) {
  if (!folder) return [];
  const dots = [];
  const readme = ['README.md', 'readme.md', 'Readme.md'].map((n) => path.join(folder, n)).find((f) => fs.existsSync(f));
  if (readme) dots.push({ id: `context:${folder}`, title: 'Context', updated: day(safeStat(readme)), excerpt: plain(fs.readFileSync(readme, 'utf8').slice(0, 2000)) });
  const pictures = [];
  let files = 0;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      files += 1;
      if (IMAGE.test(e.name)) pictures.push(full);
    }
  };
  walk(folder, 1);
  // "icon-192.png", "icon@2x.png", "logo_512x512.png" are sizes of one picture.
  const stem = (f) => path.basename(f).replace(/\.[^.]+$/, '').replace(/[-_@]?(?:\d{2,4}(?:x\d{2,4})?|\dx)$/i, '').toLowerCase();
  const rank = (f) => (/logo|icon|favicon/i.test(path.basename(f)) ? 0 : 1);
  const distinct = new Map();
  for (const f of pictures.sort((a, b) => rank(a) - rank(b) || a.length - b.length)) {
    const s = stem(f);
    if (!distinct.has(s)) distinct.set(s, `${s}${path.extname(f).toLowerCase()}`);
  }
  if (distinct.size) {
    const names = [...distinct.values()];
    dots.push({ id: `pictures:${folder}`, title: 'Pictures', updated: null, excerpt: `${names.length} picture${names.length === 1 ? '' : 's'} in ${name}: ${names.slice(0, 8).join(', ')}` });
  }
  dots.push({ id: `files:${folder}`, title: 'Files', updated: null, excerpt: `${files} file${files === 1 ? '' : 's'} in ${folder}` });
  const map = codeMapDot(folder, name);
  if (map) dots.push(map);
  return dots;
}
const isDirectory = (f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
const safeStat = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

function safeMtime(vault, id) {
  try { return fs.statSync(path.join(vault.dir, id)).mtimeMs; } catch { return null; }
}

// One note's Markdown for the side panel (shown as text, never HTML). Only .md files inside the vault.
export function readNote(vault, id) {
  const rel = String(id || '');
  if (rel === 'Actions') {
    const days = vault.list('Actions').sort((a, b) => b.title.localeCompare(a.title));
    return { title: 'Actions', text: days.map((d) => `## ${d.title}\n\n${vault.read(path.join('Actions', d.title + '.md')) || ''}`.trim()).join('\n\n') };
  }
  const parts = rel.split('/');
  const ok = /\.md$/.test(rel) && parts.length <= 2 && parts.every((p) => p && !p.startsWith('.') && !/[\\:]/.test(p));
  const abs = path.resolve(vault.dir, rel);
  if (!ok || path.relative(vault.dir, abs).startsWith('..') || path.isAbsolute(rel)) throw new Error('That is not a note.');
  const text = vault.read(rel);
  if (text === null) throw new Error('That is not a note.');
  return { title: path.basename(rel, '.md'), text };
}
