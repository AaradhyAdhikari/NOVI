import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../plugins/brain/store.js';
import { queryWords } from '../../plugins/brain/search.js';
import { createSearchWorker } from '../../plugins/brain/searchWorker.js';
import { createBrainPlugin } from '../../plugins/brain/index.js';
import { PluginHost } from '../../server/plugins/host.js';

// Live 2026-10-22: "open my github profile" took 27 s (it used to take 2–3 s). The word "my" made Novi
// look through the second brain first — 350k passages, "open*" matching nearly all of them — about 7 s
// of search plus the meaning search, on Novi's one thread, before the AI could even start.
describe('brain search off the main thread, with a time limit', () => {
  it('command words are not searched for ("open", "play", "show"… match nearly everything)', () => {
    expect(queryWords('open my linkedin profile')).toEqual(['linkedin', 'profile']);
    expect(queryWords('play the song on my laptop right now')).toEqual(['song']);
    expect(queryWords('where is my dbms exam timetable')).toEqual(['dbms', 'exam', 'timetable']);
  });

  it('the search worker reads brain.db on its own connection: words and meaning', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-search-')), 'brain.db');
    const store = openStore(file);
    store.upsert({ id: 'n1', kind: 'note', title: 'DBMS exam', mtime: 1 });
    store.setText('n1', ['The DBMS exam is on 5 November in room 204.']);
    const [row] = store.missingVectors(1);
    const v = new Int8Array(4).fill(0); v[0] = 127;
    store.addVectors([{ rowid: row.rowid, item_id: 'n1', q: v, scale: 1 / 127 }]);
    const w = createSearchWorker({ file });
    const hits = await w.search({ query: 'when is my dbms exam', qv: Float32Array.from([1, 0, 0, 0]), limit: 6 });
    expect(hits[0]).toMatchObject({ id: 'n1', title: 'DBMS exam' });
    expect(hits[0].snippet).toMatch(/5 November/);
    w.close();
    store.close();
  });

  it('files that take longer than the limit: the AI goes ahead without them, at once', async () => {
    const host = new PluginHost({ runtime: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'brain-slow-')), projects: { list: () => [] } }, logger: { warn() {}, info() {} } });
    const slow = () => new Promise((r) => setTimeout(() => r([{ id: 'x', kind: 'note', title: 'X', matched: 9, snippet: 'x' }]), 2000));
    host.register(createBrainPlugin({ dbFile: ':memory:', autoStart: false, search: slow, contextMs: 50 }));
    const started = Date.now();
    const ctx = await host.promptContext({ prompt: 'open my github profile' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ctx.context || '').toBe('');
  });
});

describe('commands never wait for your files', () => {
  it('"open my github profile", "play my playlist": no search at all; questions about your things still search', async () => {
    const { aboutOwnThings } = await import('../../plugins/brain/search.js');
    expect(aboutOwnThings('open my github profile')).toBe(false);
    expect(aboutOwnThings('Okay, play my workout playlist')).toBe(false);
    expect(aboutOwnThings('please close my notes')).toBe(false);
    expect(aboutOwnThings('where is my resume')).toBe(true);
    expect(aboutOwnThings('what does my tracebite app do')).toBe(true);
  });
});
