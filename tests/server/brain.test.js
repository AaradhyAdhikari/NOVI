import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { openStore } from '../../plugins/brain/store.js';
import { createIngest, chunkText, mayRead } from '../../plugins/brain/ingest.js';
import { searchBrain, contextFor } from '../../plugins/brain/search.js';
import { createBrainPlugin } from '../../plugins/brain/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-brain-'));

// A small laptop: two projects, a college folder, a secret file.
function laptop() {
  const root = tmp();
  const put = (rel, text, mtime = new Date(2026, 9, 10)) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    fs.utimesSync(f, mtime, mtime);
    return f;
  };
  const files = [
    put('Projects/TraceBite/README.md', '# TraceBite\n\nA food tracking app. Users scan meals and see calories.'),
    put('Projects/TraceBite/src/app.js', 'export function scanMeal() { return "calories"; }'),
    put('Projects/Portfolio/README.md', '# Portfolio\n\nMy site with a blog and a contact form.'),
    put('College/robotics submission.txt', 'Robotics submission due 3 Nov: line follower robot report.'),
    put('College/.env', 'GROQ_API_KEY=gsk_secret'),
    put('College/passwords.txt', 'gmail: hunter2'),
  ];
  const entries = () => files.map((p) => ({ path: p, name: path.basename(p, path.extname(p)).toLowerCase(), ext: path.extname(p).toLowerCase(), mtime: fs.statSync(p).mtimeMs, dir: false }))
    .concat([{ path: path.join(root, 'College'), name: 'college', ext: '', mtime: 1, dir: true }]);
  const readText = async (p) => fs.readFileSync(p, 'utf8');
  return { root, files, entries, readText };
}

async function filled(extra = {}) {
  const l = laptop();
  const store = openStore(':memory:');
  const projects = () => [{ name: 'tracebite', path: path.join(l.root, 'Projects', 'TraceBite') }, { name: 'portfolio', path: path.join(l.root, 'Projects', 'Portfolio') }];
  const notes = () => [{ title: 'TraceBite brief', text: 'Goal: launch the meal scanner first.' }, { title: 'DBMS exam', text: 'Exam on 5 Nov, normal forms first.' }];
  const ingest = createIngest({ store, entries: l.entries, readText: l.readText, projects, notes, ...extra });
  await ingest.syncAll();
  while (await ingest.readSome(10)) { /* read everything */ }
  return { ...l, store, ingest };
}

describe('brain store + ingest', () => {
  it('knows every file by name, reads inside the readable ones, never secrets', async () => {
    const b = await filled();
    const st = b.store.stats();
    expect(st.files).toBe(6);
    expect(st.read).toBe(4); // .env and passwords.txt are known by name only
    expect(mayRead(path.join(b.root, 'College/.env'))).toBe(false);
    expect(mayRead(path.join(b.root, 'College/passwords.txt'))).toBe(false);
    expect(mayRead(path.join(b.root, 'x/id_rsa.pem'))).toBe(false);
    expect(searchBrain(b.store, 'hunter2')).toEqual([]);
    expect(searchBrain(b.store, 'gsk_secret')).toEqual([]);
  });

  it('a file is read again only when it changed', async () => {
    const b = await filled();
    expect(await b.ingest.readSome(10)).toBe(0);
    const f = b.files[3];
    fs.writeFileSync(f, 'Robotics submission moved to 7 Nov.');
    fs.utimesSync(f, new Date(2026, 9, 17), new Date(2026, 9, 17));
    await b.ingest.syncAll();
    expect(await b.ingest.readSome(10)).toBe(1);
    expect(searchBrain(b.store, 'robotics submission')[0].snippet).toMatch(/7 Nov/);
  });

  it('a file that is gone is forgotten', async () => {
    const b = await filled();
    fs.rmSync(b.files[3]);
    b.files.splice(3, 1);
    await b.ingest.syncAll();
    expect(searchBrain(b.store, 'robotics')).toEqual([]);
  });

  it('long text becomes ~800-character chunks on paragraph breaks', () => {
    const parts = chunkText(`${'a'.repeat(500)}\n\n${'b'.repeat(500)}\n\n${'c'.repeat(100)}`);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length <= 900)).toBe(true);
    expect(chunkText('')).toEqual([]);
  });
});

describe('brain search', () => {
  it('finds words inside files and notes, exact names first, with the project', async () => {
    const b = await filled();
    const hits = searchBrain(b.store, 'meal calories');
    expect(hits[0]).toMatchObject({ project: 'tracebite' });
    expect(hits.map((h) => h.title)).toContain('README.md');
    expect(searchBrain(b.store, 'TraceBite')[0]).toMatchObject({ kind: 'project', title: 'TraceBite' });
    expect(searchBrain(b.store, 'normal forms')[0]).toMatchObject({ kind: 'note', title: 'DBMS exam' });
  });

  it('a project filter never returns another project\'s files', async () => {
    const b = await filled();
    const hits = searchBrain(b.store, 'blog README', { project: 'tracebite' });
    expect(hits.every((h) => h.project === 'tracebite')).toBe(true);
  });

  it('search syntax in the words is just words', async () => {
    const b = await filled();
    expect(() => searchBrain(b.store, 'robot* OR "NEAR(' )).not.toThrow();
  });

  it('the brief note belongs to its project', async () => {
    const b = await filled();
    expect(searchBrain(b.store, 'meal scanner first')[0]).toMatchObject({ kind: 'note', project: 'tracebite' });
  });
});

describe('context builder: only the evidence this request needs', () => {
  it('a question about your own stuff gets ≤ 6 passages / 1,500 characters, each with its source', async () => {
    const b = await filled();
    const ctx = contextFor(b.store, 'when is my robotics submission due?');
    expect(ctx.text).toMatch(/^From your files and notes \(use only if relevant\):\n- robotics submission\.txt \(.*College.*\): Robotics submission due 3 Nov/);
    expect(ctx.text.length).toBeLessThanOrEqual(1700);
    expect(ctx.count).toBeLessThanOrEqual(6);
  });

  it('nothing for everyday questions or when nothing matches', async () => {
    const b = await filled();
    expect(contextFor(b.store, "what's the weather today").text).toBe('');
    expect(contextFor(b.store, 'what did I write about quantum gravity').text).toBe('');
  });

  it('a named project keeps the evidence to that project', async () => {
    const b = await filled();
    const ctx = contextFor(b.store, 'what is my TraceBite README about', { projects: ['tracebite', 'portfolio'] });
    expect(ctx.text).toMatch(/TraceBite/);
    expect(ctx.text).not.toMatch(/Portfolio/);
  });
});

describe('brain plugin', () => {
  function setup() {
    const l = laptop();
    const runtime = {
      dataDir: tmp(),
      fileEntries: l.entries,
      readFileText: l.readText,
      projects: { list: () => [{ name: 'tracebite', path: path.join(l.root, 'Projects', 'TraceBite') }] },
      wikiNotes: () => [{ title: 'DBMS exam', text: 'Exam on 5 Nov.' }],
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    const plugin = createBrainPlugin({ dbFile: ':memory:', autoStart: false });
    expect(host.register(plugin)).toBe(true);
    return { host, runtime };
  }

  it('brain_search and brain_status, read-only and sensitive', async () => {
    const s = setup();
    await s.runtime.brainSync();
    const out = await s.host.get('brain_search').run({ query: 'calories' });
    expect(out.sensitive).toBe(true);
    expect(out.results[0]).toMatchObject({ project: 'tracebite' });
    expect((await s.host.get('brain_status').run({})).note).toMatch(/^I know 7 files and folders, 1 project and 1 note; I've read inside 4 files\.$/);
    expect(await s.host.get('brain_search').gate({ query: 'x' })).toEqual({});
  });

  it('adds evidence to an AI turn about your stuff, and marks it private', async () => {
    const s = setup();
    await s.runtime.brainSync();
    const ctx = await s.host.promptContext({ prompt: 'what does my tracebite app do?' });
    expect(ctx.context).toMatch(/TraceBite/);
    expect(ctx.sensitive).toBe(true);
    const none = await s.host.promptContext({ prompt: 'tell me a joke' });
    expect(none.context || '').toBe('');
  });
});

describe('AI keys check', () => {
  it('names the providers with keys and the missing ones, never a key', async () => {
    const { keysNote } = await import('../../plugins/ai-keys/index.js');
    expect(keysNote([{ name: 'groq', keys: 2 }, { name: 'gemini', keys: 1 }, { name: 'cerebras', keys: 0 }]))
      .toBe('You have keys for groq (2), gemini (1). Missing: cerebras. Add them to .env as CEREBRAS_API_KEYS=…, then restart Novi.');
    expect(keysNote([{ name: 'groq', keys: 1 }])).toBe('You have keys for groq (1). Every free AI provider Novi knows has a key.');
  });

  it.each(['which AI keys are missing', 'check my API keys', 'which AI providers do I have', 'kaunsi API keys missing hai'])('"%s" → ai_keys_status', async (text) => {
    const { keysCommand } = await import('../../server/brain/controlCommand.js');
    expect(keysCommand(text)).toEqual({ tool: 'ai_keys_status', args: {} });
  });
  it.each(['what is an API', 'missing my keys at home', 'open my keys folder'])('not this: "%s"', async (text) => {
    const { keysCommand } = await import('../../server/brain/controlCommand.js');
    expect(keysCommand(text)).toBeNull();
  });
});
