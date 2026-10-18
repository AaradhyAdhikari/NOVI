import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Novi's second brain (2026-10-18, spec docs/superpowers/specs/2026-10-18-novi-second-brain-design.md):
// one SQLite file (node:sqlite, built into Node 22.5+) holding projects, folders, files and notes, how
// they connect, and the words inside every readable file (FTS5 full-text search).
const require = createRequire(import.meta.url);

// node:sqlite prints "SQLite is an experimental feature" on first load; that line isn't a problem worth
// showing in Settings → System, so only that one warning is left out.
let sqlite;
function loadSqlite() {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite is an experimental/.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
  try { sqlite = require('node:sqlite'); } finally { process.emitWarning = emit; }
  return sqlite;
}

export function sqliteAvailable() {
  try { loadSqlite(); return true; } catch { return false; }
}

export function openStore(file) {
  const { DatabaseSync } = loadSqlite();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, kind TEXT, title TEXT, path TEXT, url TEXT, project TEXT, mtime REAL, size INTEGER, read_mtime REAL);
    CREATE INDEX IF NOT EXISTS items_kind ON items(kind);
    CREATE INDEX IF NOT EXISTS items_project ON items(project);
    CREATE INDEX IF NOT EXISTS items_path ON items(path);
    CREATE TABLE IF NOT EXISTS links (a TEXT, b TEXT, rel TEXT, PRIMARY KEY (a, b, rel));
    CREATE TABLE IF NOT EXISTS vectors (chunk INTEGER PRIMARY KEY, item_id TEXT, v BLOB, scale REAL);
    CREATE INDEX IF NOT EXISTS vectors_item ON vectors(item_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(item_id UNINDEXED, n UNINDEXED, title, path, text, tokenize = 'unicode61 remove_diacritics 2');
  `);
  const q = {
    upsert: db.prepare(`INSERT INTO items (id, kind, title, path, url, project, mtime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, path = excluded.path, url = excluded.url,
      project = COALESCE(excluded.project, items.project), mtime = excluded.mtime, size = excluded.size`),
    get: db.prepare('SELECT * FROM items WHERE id = ?'),
    delChunks: db.prepare('DELETE FROM chunks WHERE item_id = ?'),
    delVectors: db.prepare('DELETE FROM vectors WHERE item_id = ?'),
    addVector: db.prepare('INSERT OR REPLACE INTO vectors (chunk, item_id, v, scale) VALUES (?, ?, ?, ?)'),
    addChunk: db.prepare('INSERT INTO chunks (item_id, n, title, path, text) VALUES (?, ?, ?, ?, ?)'),
    readMark: db.prepare('UPDATE items SET read_mtime = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM items WHERE id = ?'),
    delLinks: db.prepare('DELETE FROM links WHERE a = ? OR b = ?'),
    link: db.prepare('INSERT OR IGNORE INTO links (a, b, rel) VALUES (?, ?, ?)'),
  };
  let version = 0; // bumps when vectors change, so the in-memory matrix is rebuilt
  let matrix = null; // { version, n, dims, q: Int8Array, scale: Float32Array, chunk: [], item: [] }
  const tx = (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; } };

  return {
    db,
    tx,
    get: (id) => q.get.get(id) || null,
    // An item by name; with `chunks`, its searchable text too (names alone get one empty chunk).
    upsert({ id, kind, title, path: p = null, url = null, project = null, mtime = null, size = null }) {
      const isNew = !q.get.get(id);
      q.upsert.run(id, kind, title, p, url, project, mtime, size);
      if (isNew) q.addChunk.run(id, 0, title, p || '', '');
      return isNew;
    },
    setText(id, texts, readMtime = null) {
      const item = q.get.get(id);
      if (!item) return;
      q.delChunks.run(id);
      if (q.delVectors.run(id).changes) version += 1;
      const parts = texts.length ? texts : [''];
      parts.forEach((t, n) => q.addChunk.run(id, n, item.title, item.path || '', t));
      q.readMark.run(readMtime, id);
    },
    remove(id) { q.delChunks.run(id); if (q.delVectors.run(id).changes) version += 1; q.delLinks.run(id, id); q.del.run(id); },
    link(a, b, rel) { q.link.run(a, b, rel); },
    ids: (kind) => db.prepare('SELECT id FROM items WHERE kind = ?').all(kind).map((r) => r.id),
    // Files inside a folder belong to its project.
    claim(folder, project) {
      const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
      // A range on the path index (fast even with hundreds of thousands of files).
      db.prepare("UPDATE items SET project = ? WHERE kind IN ('file', 'folder') AND (path = ? OR (path >= ? AND path < ?))").run(project, folder, prefix, `${prefix}\u{10FFFF}`);
    },
    unread: (limit) => db.prepare("SELECT * FROM items WHERE kind = 'file' AND (read_mtime IS NULL OR read_mtime != mtime) LIMIT ?").all(limit),
    // Passages still without their meaning vector: notes and projects first, then the newest files.
    missingVectors(limit) {
      return db.prepare(`SELECT c.rowid AS rowid, c.item_id AS item_id, c.text AS text FROM chunks c
        JOIN items i ON i.id = c.item_id LEFT JOIN vectors v ON v.chunk = c.rowid
        WHERE v.chunk IS NULL AND c.text != ''
        ORDER BY CASE i.kind WHEN 'note' THEN 0 WHEN 'project' THEN 0 ELSE 1 END, i.mtime DESC LIMIT ?`).all(limit);
    },
    addVectors(rows) {
      tx(() => { for (const r of rows) q.addVector.run(r.rowid, r.item_id, Buffer.from(r.q.buffer, r.q.byteOffset, r.q.byteLength), r.scale); });
      version += 1;
    },
    // The k passages closest in meaning to a unit vector (int8 dot products), optionally one project's.
    nearest(vec, k = 20, project = null) {
      if (!matrix || matrix.version !== version) {
        const rows = db.prepare('SELECT v.chunk AS chunk, v.item_id AS item_id, v.v AS v, v.scale AS scale, i.project AS project FROM vectors v JOIN items i ON i.id = v.item_id').all();
        const dims = rows[0] ? rows[0].v.length : vec.length;
        const qm = new Int8Array(rows.length * dims);
        rows.forEach((r, i) => qm.set(new Int8Array(r.v.buffer, r.v.byteOffset, dims), i * dims));
        matrix = { version, n: rows.length, dims, q: qm, scale: Float32Array.from(rows.map((r) => r.scale)), chunk: rows.map((r) => r.chunk), item: rows.map((r) => r.item_id), project: rows.map((r) => r.project) };
      }
      const m = matrix;
      const best = [];
      for (let i = 0; i < m.n; i++) {
        if (project && m.project[i] !== project) continue;
        let dot = 0;
        const off = i * m.dims;
        for (let d = 0; d < m.dims; d++) dot += vec[d] * m.q[off + d];
        const sim = dot * m.scale[i];
        if (best.length < k || sim > best[best.length - 1].sim) {
          best.push({ chunk: m.chunk[i], item_id: m.item[i], sim });
          best.sort((a, b) => b.sim - a.sim);
          if (best.length > k) best.pop();
        }
      }
      return best;
    },
    chunkText: (rowid) => db.prepare('SELECT text FROM chunks WHERE rowid = ?').get(rowid)?.text || '',
    stats() {
      const count = (sql) => db.prepare(sql).get().n;
      return {
        files: count("SELECT COUNT(*) n FROM items WHERE kind = 'file'"),
        folders: count("SELECT COUNT(*) n FROM items WHERE kind = 'folder'"),
        projects: count("SELECT COUNT(*) n FROM items WHERE kind = 'project'"),
        notes: count("SELECT COUNT(*) n FROM items WHERE kind = 'note'"),
        read: count("SELECT COUNT(*) n FROM items WHERE kind = 'file' AND read_mtime IS NOT NULL AND read_mtime = mtime AND id IN (SELECT item_id FROM chunks WHERE text != '')"),
        pending: count("SELECT COUNT(*) n FROM items WHERE kind = 'file' AND (read_mtime IS NULL OR read_mtime != mtime)"),
        vectors: count('SELECT COUNT(*) n FROM vectors'),
        unvectored: count("SELECT COUNT(*) n FROM chunks c LEFT JOIN vectors v ON v.chunk = c.rowid WHERE v.chunk IS NULL AND c.text != ''"),
      };
    },
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}
