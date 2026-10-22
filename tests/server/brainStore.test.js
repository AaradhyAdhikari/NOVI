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

// Live 2026-10-22: Novi was blocked 10–40 s at a time. Every file was read and every passage had its
// vector, yet the brain asked again every 1.5 s: "which files are unread" (230 ms) and "which passages
// need a vector" (2.4 s with 350k passages). Once a search finds nothing, it waits for something new.
describe('brain store: no repeated empty searches', () => {
  const counting = (store) => {
    const seen = { unread: 0, vectors: 0 };
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => {
      if (/read_mtime IS NULL/.test(sql)) seen.unread += 1;
      if (/LIMIT/.test(sql) && /vec_todo|LEFT JOIN vectors/.test(sql)) seen.vectors += 1;
      return prepare(sql);
    };
    return seen;
  };

  it('nothing left to read → not searched again until a file is new or changed', () => {
    const store = openStore(':memory:');
    store.upsert({ id: 'f1', kind: 'file', title: 'a.txt', path: '/a.txt', mtime: 1 });
    store.setText('f1', ['hello'], 1);
    const seen = counting(store);
    expect(store.unread(4)).toEqual([]);
    expect(store.unread(4)).toEqual([]);
    expect(seen.unread).toBe(1);
    store.upsert({ id: 'f1', kind: 'file', title: 'a.txt', path: '/a.txt', mtime: 1 }); // same file, unchanged
    expect(store.unread(4)).toEqual([]);
    expect(seen.unread).toBe(1);
    store.upsert({ id: 'f1', kind: 'file', title: 'a.txt', path: '/a.txt', mtime: 2 }); // changed on disk
    expect(store.unread(4).map((r) => r.id)).toEqual(['f1']);
    store.upsert({ id: 'f2', kind: 'file', title: 'b.txt', path: '/b.txt', mtime: 1 }); // new
    expect(store.unread(4).map((r) => r.id)).toEqual(['f1', 'f2']);
  });

  it('every passage has its vector → not searched again until new text arrives', () => {
    const store = openStore(':memory:');
    store.upsert({ id: 'f1', kind: 'file', title: 'a.txt', path: '/a.txt', mtime: 1 });
    store.setText('f1', ['hello'], 1);
    const [row] = store.missingVectors(16);
    store.addVectors([{ rowid: row.rowid, item_id: row.item_id, q: new Int8Array([1, 2]), scale: 1 }]);
    const seen = counting(store);
    expect(store.missingVectors(16)).toEqual([]);
    expect(store.missingVectors(16)).toEqual([]);
    expect(seen.vectors).toBeLessThanOrEqual(1); // the pick is prepared once, when the store opens
    store.setText('f1', ['hello again'], 2);
    expect(store.missingVectors(16).map((r) => r.text)).toEqual(['hello again']);
  });
});

// Live 2026-10-22 (profile): each time new text came in, finding the passages without a vector scanned all
// 350k passages — up to 32 s inside Novi. A small to-do list of waiting passages makes it one lookup.
describe('brain store: passages waiting for a vector are a short list', () => {
  const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-todo-')), 'brain.db');

  it('the pick never scans every passage; notes first, then the newest files', () => {
    const store = openStore(':memory:');
    store.upsert({ id: 'old', kind: 'file', title: 'old.txt', path: '/old.txt', mtime: 1 });
    store.upsert({ id: 'new', kind: 'file', title: 'new.txt', path: '/new.txt', mtime: 9 });
    store.upsert({ id: 'n1', kind: 'note', title: 'My note', mtime: 0 });
    store.setText('old', ['old words'], 1);
    store.setText('new', ['new words'], 9);
    store.setText('n1', ['note words']);
    const scans = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => { if (/LEFT JOIN vectors/.test(sql)) scans.push(sql); return prepare(sql); };
    expect(store.missingVectors(3).map((r) => r.text)).toEqual(['note words', 'new words', 'old words']);
    expect(scans).toEqual([]);
  });

  it('a vector made, or the text replaced, takes the passage off the list', () => {
    const store = openStore(':memory:');
    store.upsert({ id: 'f', kind: 'file', title: 'f.txt', path: '/f.txt', mtime: 1 });
    store.setText('f', ['one'], 1);
    const [row] = store.missingVectors(1);
    store.addVectors([{ rowid: row.rowid, item_id: 'f', q: new Int8Array([1]), scale: 1 }]);
    expect(store.stats().unvectored).toBe(0);
    store.setText('f', ['two', 'three'], 2);
    expect(store.stats().unvectored).toBe(2);
    store.remove('f');
    expect(store.stats().unvectored).toBe(0);
  });

  it('an older brain.db (no list yet) gets its list once, from what is missing', () => {
    const file = tmpDb();
    let store = openStore(file);
    store.upsert({ id: 'f', kind: 'file', title: 'f.txt', path: '/f.txt', mtime: 1 });
    store.setText('f', ['waiting text'], 1);
    store.db.exec('DROP TABLE vec_todo');
    store.close();
    store = openStore(file);
    expect(store.missingVectors(4).map((r) => r.text)).toEqual(['waiting text']);
    store.close();
  });
});
