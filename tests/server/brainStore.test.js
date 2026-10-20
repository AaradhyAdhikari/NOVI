import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openStore } from '../../plugins/brain/store.js';

// Live 2026-10-20: with 324k passages Novi froze for 30 s at a time and then for hours. Every file the
// brain read first deleted its old passages with `WHERE item_id = ?` — an UNINDEXED full-text column,
// so each delete scanned every passage. Passages are now found through the chunk_items table.
const tmp = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const file = (store, id, title = id) => store.upsert({ id, kind: 'file', title, path: `C:\\x\\${title}`, mtime: 1 });
const count = (store, sql) => store.db.prepare(sql).get().n;

describe('brain store: passages found through chunk_items', () => {
  it('setText replaces only that file\'s passages and keeps chunk_items in step', () => {
    const store = openStore(':memory:');
    file(store, 'a'); file(store, 'b');
    store.setText('a', ['alpha one', 'alpha two'], 1);
    store.setText('b', ['beta'], 1);
    store.setText('a', ['alpha three'], 2);
    const texts = store.db.prepare('SELECT item_id, text FROM chunks ORDER BY item_id, n').all().map((r) => `${r.item_id}:${r.text}`);
    expect(texts).toEqual(['a:alpha three', 'b:beta']);
    expect(count(store, 'SELECT COUNT(*) n FROM chunk_items')).toBe(count(store, 'SELECT COUNT(*) n FROM chunks'));
  });

  it('remove takes the file\'s passages and their chunk_items rows with it', () => {
    const store = openStore(':memory:');
    file(store, 'a'); file(store, 'b');
    store.setText('a', ['alpha'], 1);
    store.remove('a');
    expect(count(store, "SELECT COUNT(*) n FROM chunks WHERE item_id = 'a'")).toBe(0);
    expect(count(store, "SELECT COUNT(*) n FROM chunk_items WHERE item_id = 'a'")).toBe(0);
    expect(count(store, 'SELECT COUNT(*) n FROM chunk_items')).toBe(1);
  });

  it('setText works inside an outer transaction (notes are written that way)', () => {
    const store = openStore(':memory:');
    store.tx(() => { file(store, 'n'); store.setText('n', ['note text'], 1); });
    expect(count(store, "SELECT COUNT(*) n FROM chunks WHERE text = 'note text'")).toBe(1);
  });

  it('an older brain.db without chunk_items is filled in once when opened', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-brain-'));
    tmp.push(dir);
    const dbFile = path.join(dir, 'brain.db');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const old = new DatabaseSync(dbFile);
    old.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT, title TEXT, path TEXT, url TEXT, project TEXT, mtime REAL, size INTEGER, read_mtime REAL);
      CREATE VIRTUAL TABLE chunks USING fts5(item_id UNINDEXED, n UNINDEXED, title, path, text, tokenize = 'unicode61 remove_diacritics 2');
      INSERT INTO items (id, kind, title, mtime, read_mtime) VALUES ('a', 'file', 'a', 1, 1), ('b', 'file', 'b', 1, NULL);
      INSERT INTO chunks (item_id, n, title, path, text) VALUES ('a', 0, 'a', '', 'old text'), ('b', 0, 'b', '', '');`);
    old.close();

    const store = openStore(dbFile);
    try {
      expect(count(store, 'SELECT COUNT(*) n FROM chunk_items')).toBe(2);
      store.setText('a', ['new text'], 1);
      expect(store.db.prepare("SELECT text FROM chunks WHERE item_id = 'a'").all().map((r) => r.text)).toEqual(['new text']);
      expect(store.stats()).toMatchObject({ files: 2, read: 1, unvectored: 1 });
    } finally { store.close(); }
  });

  it('missingVectors: passages with text and no vector, notes first; stats count them', () => {
    const store = openStore(':memory:');
    file(store, 'f');
    store.upsert({ id: 'note', kind: 'note', title: 'note' });
    store.setText('f', ['file words', 'more file words'], 1);
    store.setText('note', ['note words'], 1);
    const first = store.missingVectors(10);
    expect(first.map((r) => r.text)).toEqual(['note words', 'file words', 'more file words']);
    store.addVectors([{ rowid: first[0].rowid, item_id: 'note', q: new Int8Array([1, 2]), scale: 1 }]);
    expect(store.missingVectors(10).map((r) => r.text)).toEqual(['file words', 'more file words']);
    expect(store.stats()).toMatchObject({ read: 1, vectors: 1, unvectored: 2 });
  });

  it('works through its picked queue a few at a time and skips passages that are gone meanwhile', () => {
    const store = openStore(':memory:');
    file(store, 'f'); file(store, 'g');
    store.setText('f', ['f1', 'f2', 'f3'], 1);
    store.setText('g', ['g1'], 1);
    const seen = store.missingVectors(1).map((r) => r.text);
    store.remove('f'); // its other passages were already queued
    for (let i = 0; i < 5; i++) seen.push(...store.missingVectors(1).map((r) => r.text));
    expect(seen.filter((t) => t.startsWith('f'))).toHaveLength(1);
    expect(seen).toContain('g1');
  });
});
