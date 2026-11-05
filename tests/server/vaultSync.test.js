import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession, sessionNote } from '../../plugins/vault-sync/sessions.js';
import { projectNote } from '../../plugins/vault-sync/laptop.js';
import { mirror } from '../../plugins/vault-sync/mirror.js';
import { syncOnce } from '../../plugins/vault-sync/sync.js';

// User, 2026-11-05: Claude Brain = Claude, its sessions, the laptop. Novi Brain = all of that plus Novi.
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sync-'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rows = (...r) => r.map((x) => JSON.stringify(x)).join('\n');
const asked = (text) => ({ type: 'user', cwd: 'C:\\dev\\Shop', timestamp: '2026-11-05T10:00:00Z', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const wrote = (file) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } });

function session(dir, name, ...r) {
  const file = path.join(dir, 'C--dev-Shop', `${name}.jsonl`);
  put(file, rows(...r));
  return file;
}

describe('a session as a short note', () => {
  it('keeps the project, the ask, what got done and the files', async () => {
    const dir = temp();
    const s = await readSession(session(dir, 'abcd1234-x', asked('add a login page'), wrote('C:\\dev\\Shop\\login.html'), said('Added the login page. All tests pass. More words after.')));
    expect(s).toMatchObject({ id: 'abcd1234', project: 'Shop', date: '2026-11-05', asked: 'add a login page', files: ['login.html'] });
    expect(s.done).toContain('Added the login page.');
  });
  it('the note links to its project and says what happened', async () => {
    const dir = temp();
    const s = await readSession(session(dir, 'abcd1234-x', asked('add a login page'), said('Added it.')));
    const n = sessionNote(s);
    expect(n.rel.replace(/\\/g, '/')).toBe('Shop/2026-11-05 add a login page abcd1234.md');
    expect(n.text).toContain('[[Shop]]');
    expect(n.text).toContain('add a login page');
    expect(n.text).toContain('Added it.');
  });
  it('lines that look secret are left out', async () => {
    const dir = temp();
    const s = await readSession(session(dir, 'abcd1234-x', asked('set the password to hunter2\nand add login'), said('Done.')));
    expect(sessionNote(s).text).not.toContain('hunter2');
  });
  it('a session with no request is no note', async () => {
    const dir = temp();
    expect(await readSession(session(dir, 'empty', said('hello')))).toBe(null);
  });
  it('the app\'s hidden tags are not part of the ask', async () => {
    const dir = temp();
    const s = await readSession(session(dir, 'abcd1234-x', asked('<system-reminder>hidden</system-reminder>fix the cart'), said('Fixed.')));
    expect(s.asked).toBe('fix the cart');
  });
});

describe('a project as a note', () => {
  it('says where it is, what is in it and what changed', async () => {
    const dir = temp();
    put(path.join(dir, 'README.md'), '# Shop');
    put(path.join(dir, 'src', 'a.js'), '1');
    put(path.join(dir, 'node_modules', 'x', 'y.js'), '1');
    const n = await projectNote({ name: 'Shop', path: dir }, { log: async () => ['Fix cart', 'Add login'] });
    expect(n.rel).toBe('Shop.md');
    expect(n.text).toContain(dir);
    expect(n.text).toContain('README.md');
    expect(n.text).toContain('src/');
    expect(n.text).not.toContain('node_modules');
    expect(n.text).toContain('Fix cart');
  });
  it('a folder that is gone is no note', async () => {
    expect(await projectNote({ name: 'Gone', path: path.join(temp(), 'nope') })).toBe(null);
  });
});

describe('the copy of Claude Brain', () => {
  it('copies notes, follows changes, and removes what was removed', async () => {
    const from = temp();
    const to = path.join(temp(), 'Claude Brain');
    put(path.join(from, 'About-Me.md'), 'one');
    put(path.join(from, 'Projects', 'K.md'), 'two');
    put(path.join(from, '.obsidian', 'app.json'), '{}');
    await mirror(from, to);
    expect(fs.readFileSync(path.join(to, 'Projects', 'K.md'), 'utf8')).toBe('two');
    expect(fs.existsSync(path.join(to, '.obsidian'))).toBe(false);
    put(path.join(from, 'About-Me.md'), 'changed');
    fs.rmSync(path.join(from, 'Projects', 'K.md'));
    await mirror(from, to);
    expect(fs.readFileSync(path.join(to, 'About-Me.md'), 'utf8')).toBe('changed');
    expect(fs.existsSync(path.join(to, 'Projects', 'K.md'))).toBe(false);
  });
  it('never changes the original', async () => {
    const from = temp();
    const to = path.join(temp(), 'Claude Brain');
    put(path.join(from, 'A.md'), 'mine');
    await mirror(from, to);
    put(path.join(to, 'A.md'), 'edited in the copy');
    await mirror(from, to);
    expect(fs.readFileSync(path.join(from, 'A.md'), 'utf8')).toBe('mine');
  });
  it('refuses a copy inside the original, or the other way round', async () => {
    const from = temp();
    await expect(mirror(from, path.join(from, 'x'))).rejects.toThrow();
    await expect(mirror(path.join(from, 'x'), from)).rejects.toThrow();
  });
  it('an empty or missing original never wipes the copy', async () => {
    const to = path.join(temp(), 'Claude Brain');
    put(path.join(to, 'A.md'), 'kept');
    await mirror(path.join(temp(), 'missing'), to).catch(() => {});
    await mirror(temp(), to);
    expect(fs.existsSync(path.join(to, 'A.md'))).toBe(true);
  });
});

describe('one sync', () => {
  const setup = () => {
    const home = temp();
    const sessions = path.join(home, 'projects');
    const brain = path.join(home, 'Brain');
    const novi = path.join(home, 'Novi Brain');
    put(path.join(brain, 'About-Me.md'), 'me');
    const shop = path.join(home, 'Shop');
    put(path.join(shop, 'index.html'), 'x');
    session(sessions, 'abcd1234-x', asked('add a login page'), said('Added it.'));
    return { home, sessions, brain, novi, projects: [{ name: 'Shop', path: shop }], state: {} };
  };

  it('fills Claude Brain, then copies it all into Novi Brain', async () => {
    const s = setup();
    await syncOnce(s);
    expect(fs.existsSync(path.join(s.brain, 'Laptop', 'Shop.md'))).toBe(true);
    expect(fs.readdirSync(path.join(s.brain, 'Sessions', 'Shop')).length).toBe(1);
    expect(fs.existsSync(path.join(s.novi, 'Claude Brain', 'About-Me.md'))).toBe(true);
    expect(fs.existsSync(path.join(s.novi, 'Claude Brain', 'Laptop', 'Shop.md'))).toBe(true);
  });
  it('both brains hold everything, and neither copy loops into the other', async () => {
    const s = setup();
    put(path.join(s.novi, 'Notes', 'Portfolio brief.md'), 'from Novi');
    put(path.join(s.novi, 'Actions', '2026-11-05.md'), 'did things');
    await syncOnce(s);
    await syncOnce(s);
    expect(fs.readFileSync(path.join(s.brain, 'Novi', 'Notes', 'Portfolio brief.md'), 'utf8')).toBe('from Novi');
    expect(fs.existsSync(path.join(s.brain, 'Novi', 'Actions', '2026-11-05.md'))).toBe(true);
    expect(fs.existsSync(path.join(s.brain, 'Novi', 'Claude Brain'))).toBe(false);
    expect(fs.existsSync(path.join(s.novi, 'Claude Brain', 'Novi'))).toBe(false);
    expect(fs.existsSync(path.join(s.novi, 'Claude Brain', 'About-Me.md'))).toBe(true);
  });
  it('writes nothing else in Claude Brain', async () => {
    const s = setup();
    await syncOnce(s);
    put(path.join(s.novi, 'Notes', 'A.md'), 'x');
    await syncOnce(s);
    expect(fs.readdirSync(s.brain).sort()).toEqual(['About-Me.md', 'Laptop', 'Novi', 'Sessions']);
    expect(fs.readFileSync(path.join(s.brain, 'About-Me.md'), 'utf8')).toBe('me');
  });
  it('background observer sessions make no notes', async () => {
    const s = setup();
    put(path.join(s.sessions, 'C--Users-A--claude-mem-observer-sessions', 'o1.jsonl'), rows(asked('observe this'), said('ok')));
    await syncOnce(s);
    expect(fs.readdirSync(path.join(s.brain, 'Sessions'))).toEqual(['Shop']);
  });
  it('a session is read again only when it changed', async () => {
    const s = setup();
    let reads = 0;
    const read = async (f) => { reads += 1; return readSession(f); };
    await syncOnce({ ...s, read });
    await syncOnce({ ...s, read });
    expect(reads).toBe(1);
  });
  it('sessions older than the limit are left', async () => {
    const s = setup();
    const file = path.join(s.sessions, 'C--dev-Shop', 'abcd1234-x.jsonl');
    fs.utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
    await syncOnce(s);
    expect(fs.existsSync(path.join(s.brain, 'Sessions'))).toBe(false);
  });
});
