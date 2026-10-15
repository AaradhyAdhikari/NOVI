// The notes galaxy (Settings → Memory): every Markdown file in the vault is a dot, [[links]] and
// plain mentions of another note's title are lines. The daily Actions files are one "Actions" dot.
import fs from 'node:fs';
import path from 'node:path';

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
  return { nodes, links };
}

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
