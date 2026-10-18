import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every folder Claude Code has worked in on this laptop (user, 2026-10-18: "all my previous projects
// too"). Claude Code keeps each conversation as ~/.claude/projects/<folder>/<session>.jsonl; its lines
// carry the folder (`cwd`). Only the start of the newest file is read: the folder and what it was about.
const HEAD_BYTES = 64 * 1024;

function head(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : '');

// The folder and a few words about it (Claude Code's own summary, else the first real request).
function read(file) {
  let cwd = null;
  let summary = null;
  let first = null;
  for (const raw of head(file)) {
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (o.type === 'summary' && o.summary && !summary) summary = String(o.summary);
    if (o.cwd && !cwd) cwd = String(o.cwd);
    if (o.type === 'user' && !first) {
      const t = textOf(o.message?.content).trim();
      if (t && !t.startsWith('<')) first = t;
    }
    if (cwd && (summary || first)) break;
  }
  const about = (summary || first || '').replace(/\s+/g, ' ').slice(0, 120);
  return { cwd, about };
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const inside = (child, parent) => { const rel = path.relative(parent, child); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };

export function listClaudeCodeProjects({ home = os.homedir(), dir = path.join(home, '.claude', 'projects') } = {}) {
  let folders = [];
  try { folders = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
  const byPath = new Map();
  for (const f of folders) {
    const files = (() => { try { return fs.readdirSync(path.join(dir, f.name)).filter((n) => n.endsWith('.jsonl')); } catch { return []; } })()
      .map((n) => { const p = path.join(dir, f.name, n); return { p, mtime: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) continue;
    const { cwd, about } = read(files[0].p);
    if (!cwd) continue;
    const at = path.resolve(cwd);
    if (at === path.resolve(home) || path.parse(at).root === at || !isDir(at)) continue;
    const prev = byPath.get(at);
    const lastUsed = files[0].mtime;
    if (prev) { prev.sessions += files.length; if (lastUsed > prev.ms) Object.assign(prev, { ms: lastUsed, about: about || prev.about }); continue; }
    byPath.set(at, { name: path.basename(at), path: at, ms: lastUsed, sessions: files.length, about });
  }
  const all = [...byPath.values()];
  // Claude opened in a sub-folder (portfolio/src) belongs to the project around it.
  return all
    .filter((p) => !all.some((o) => inside(p.path, o.path)))
    .sort((a, b) => b.ms - a.ms)
    .map(({ ms, ...p }) => ({ ...p, lastUsed: new Date(ms).toISOString() }));
}
