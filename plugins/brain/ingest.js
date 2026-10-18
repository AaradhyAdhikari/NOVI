import fs from 'node:fs';
import path from 'node:path';
import { looksSecret } from '../wiki/vault.js';

// Fills the brain: the names of every file and folder (the files plugin's index), the words inside every
// readable file (user, 2026-10-18: "everything readable"), Novi's projects and her notes. Files are read
// a few at a time in the background, and again only when they change.
export const READABLE = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.yml', '.yaml', '.sh', '.ps1', '.ipynb', '.log', '.docx', '.xlsx', '.pptx', '.pdf']);
const SECRET_EXT = new Set(['.pem', '.key', '.pfx', '.p12', '.kdbx', '.keystore', '.jks', '.ppk', '.crt', '.cer']);
const SECRET_NAME = /(?:^\.env|password|passwd|secret|credential|token|\botp\b|id_rsa|id_ed25519|private[ _-]?key|wallet|seed[ _-]?phrase)/i;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 60_000;
const CHUNK = 800;

// Known by name only, never opened: env files, keys, password-like names.
export function mayRead(file) {
  const base = path.basename(file);
  return !SECRET_EXT.has(path.extname(base).toLowerCase()) && !SECRET_NAME.test(base);
}

// ~800-character pieces, cut at paragraph (else line) breaks.
export function chunkText(text) {
  const out = [];
  let cur = '';
  for (const part of String(text || '').split(/\n\s*\n|\n(?=#)/)) {
    const p = part.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > CHUNK) { out.push(cur); cur = ''; }
    if (p.length > CHUNK) { for (let i = 0; i < p.length; i += CHUNK) out.push(p.slice(i, i + CHUNK)); continue; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

// Lines that look like passwords, codes, card numbers or API keys never enter the brain.
const withoutSecrets = (text) => String(text).split('\n').filter((l) => !looksSecret(l)).join('\n');

export function createIngest({ store, entries = () => [], readText, projects = () => [], notes = () => [], skipDirs = [], log = () => {} }) {
  const skipped = (p) => skipDirs.some((d) => d && (p === d || p.startsWith(d + path.sep)));

  // Only new or changed names are written, 2,000 at a time with a pause in between, so a laptop with
  // hundreds of thousands of files never freezes Novi.
  let known = null; // id → mtime already in the store
  async function syncNames() {
    const list = entries() || [];
    if (!list.length) return;
    if (!known) {
      known = new Map();
      for (const kind of ['file', 'folder']) for (const r of store.db.prepare('SELECT id, mtime FROM items WHERE kind = ?').all(kind)) known.set(r.id, r.mtime);
    }
    const keep = new Set();
    const todo = [];
    for (const e of list) {
      if (skipped(e.path)) continue;
      const id = `${e.dir ? 'folder' : 'file'}:${e.path}`;
      keep.add(id);
      if (!known.has(id) || known.get(id) !== (e.mtime ?? null)) todo.push({ id, e });
    }
    const gone = [...known.keys()].filter((id) => !keep.has(id));
    for (let i = 0; i < todo.length; i += 2000) {
      store.tx(() => {
        for (const { id, e } of todo.slice(i, i + 2000)) {
          store.upsert({ id, kind: e.dir ? 'folder' : 'file', title: path.basename(e.path), path: e.path, mtime: e.mtime ?? null, size: e.size ?? null });
          known.set(id, e.mtime ?? null);
        }
      });
      await new Promise((r) => setImmediate(r));
    }
    store.tx(() => { for (const id of gone) { store.remove(id); known.delete(id); } });
  }

  function syncProjects() {
    const list = projects() || [];
    const keep = new Set();
    store.tx(() => {
      for (const p of list) {
        const id = `project:${p.name}`;
        keep.add(id);
        store.upsert({ id, kind: 'project', title: p.path ? path.basename(p.path) : p.name, path: p.path || null, url: p.url || null, project: p.name });
        if (p.path) { store.claim(p.path, p.name); store.link(id, `folder:${p.path}`, 'folder'); }
      }
      for (const id of store.ids('project')) if (!keep.has(id)) store.remove(id);
    });
    return list;
  }

  function syncNotes(projectList) {
    const list = notes() || [];
    const keep = new Set();
    const owner = (title) => {
      const t = title.toLowerCase();
      return projectList.find((p) => [p.name, p.path && path.basename(p.path)].filter(Boolean).some((n) => t === n.toLowerCase() || t.startsWith(`${n.toLowerCase()} `)))?.name || null;
    };
    store.tx(() => {
      for (const n of list) {
        const id = `note:${n.title}`;
        keep.add(id);
        const project = owner(n.title);
        store.upsert({ id, kind: 'note', title: n.title, project });
        store.setText(id, chunkText(withoutSecrets(n.text)), 0);
        if (project) store.link(`project:${project}`, id, 'note');
      }
      for (const id of store.ids('note')) if (!keep.has(id)) store.remove(id);
    });
  }

  return {
    async syncAll() {
      await syncNames();
      const list = syncProjects();
      syncNotes(list);
    },
    // Reads up to `n` new or changed files; returns how many it looked at (0 = all read).
    async readSome(n = 5) {
      const batch = store.unread(n);
      for (const item of batch) {
        const ext = path.extname(item.path || '').toLowerCase();
        let texts = [];
        if (READABLE.has(ext) && mayRead(item.path)) {
          try {
            const size = item.size ?? fs.statSync(item.path).size;
            if (size <= MAX_BYTES) texts = chunkText(withoutSecrets(String(await readText(item.path)).slice(0, MAX_CHARS)));
          } catch (err) { log(`[brain] couldn't read ${path.basename(item.path)}: ${err.message}`); }
        }
        store.setText(item.id, texts, item.mtime);
      }
      return batch.length;
    },
  };
}
