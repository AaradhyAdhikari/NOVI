import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createYourNotes } from '../../plugins/wiki/yourNotes.js';
import { createVault } from '../../plugins/wiki/vault.js';
import { createNotes } from '../../plugins/wiki/notes.js';

// User, 2026-11-05: one Obsidian vault. Novi writes in Brain\Novi and reads the rest, never changing it.
function brain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('.obsidian/app.json', '{}');
  put('About-Me.md', '---\nkind: me\n---\n\n# About me\n\nI study mechatronics in Pune.');
  put('Projects/KrishiChain/Overview.md', 'KrishiChain tracks farm produce.');
  put('.trash/old.md', 'gone');
  put('Novi/Notes/Portfolio brief.md', 'Novi wrote this.');
  return { root, dir: path.join(root, 'Novi'), put };
}

describe('your notes', () => {
  it('reads them, leaving out Novi\'s own, Obsidian\'s and the bin', () => {
    const { root, dir } = brain();
    const yours = createYourNotes({ root, skip: dir });
    expect(yours.list().map((n) => n.title).sort()).toEqual(['About-Me', 'Overview']);
    expect(yours.list().find((n) => n.title === 'About-Me').text).toContain('I study mechatronics');
    expect(yours.list().find((n) => n.title === 'About-Me').text).not.toContain('kind: me');
  });
  it('leaves out lines that look secret', () => {
    const { root, dir, put } = brain();
    put('Keys.md', 'Wifi notes\nMy password is hunter2\nRouter is upstairs');
    const text = createYourNotes({ root, skip: dir }).list().find((n) => n.title === 'Keys').text;
    expect(text).toContain('Router is upstairs');
    expect(text).not.toContain('hunter2');
  });
  it('a vault too big to read at once stops at the limit', () => {
    const { root, dir, put } = brain();
    for (let i = 0; i < 12; i++) put(`Many/n${i}.md`, 'x');
    expect(createYourNotes({ root, skip: dir, limit: 5 }).list().length).toBe(5);
  });
  it('sees a new note after a while, without reading the disk every time', () => {
    let t = 0;
    const { root, dir, put } = brain();
    const yours = createYourNotes({ root, skip: dir, now: () => t, keepMs: 1000 });
    yours.list();
    put('New.md', 'new');
    expect(yours.list().length).toBe(2);
    t = 2000;
    expect(yours.list().length).toBe(3);
  });
  it('no vault: nothing, and nothing breaks', () => {
    expect(createYourNotes({ root: null }).list()).toEqual([]);
  });
});

describe('asking across both', () => {
  const setup = () => {
    const { root, dir } = brain();
    const vault = createVault(dir);
    const notes = createNotes({ vault, yours: createYourNotes({ root, skip: dir }) });
    return { root, dir, notes };
  };
  it('a question finds your notes too', () => {
    const { notes } = setup();
    expect(notes.search('where do I study mechatronics').map((n) => n.title)).toContain('About-Me');
  });
  it('writing a note with the same name never touches yours', () => {
    const { notes, root, dir } = setup();
    const before = fs.readFileSync(path.join(root, 'About-Me.md'), 'utf8');
    notes.write({ title: 'About-Me', text: 'Something new' });
    expect(fs.readFileSync(path.join(root, 'About-Me.md'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'Notes', 'About-Me.md'))).toBe(true);
  });
});
