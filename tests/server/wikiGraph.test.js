import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../../plugins/wiki/vault.js';
import { buildGraph, readNote } from '../../plugins/wiki/graph.js';

function vaultWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-graph-'));
  const vault = createVault(dir);
  vault.ensure();
  for (const [rel, text] of Object.entries(files)) vault.write(rel, text);
  return vault;
}

describe('buildGraph: the notes galaxy', () => {
  const vault = vaultWith({
    'Notes/DBMS exam.md': '---\ncreated: 2026-10-15\nupdated: 2026-10-15\nsource: novi\n---\n\n# DBMS exam\n\nOn 3 Nov, revise [[Normal forms]] first.',
    'Notes/Normal forms.md': '# Normal forms\n\n1NF, 2NF, 3NF.',
    'Notes/Study plan.md': `# Study plan\n\nThe dbms exam comes first. ${'x'.repeat(400)}`,
    'Actions/2026-10-14.md': '- 10:00 Made folder **a**',
    'Actions/2026-10-15.md': '- 11:00 Made folder **b**',
  });
  const g = buildGraph(vault);
  const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));

  it('makes one dot per note and one "Actions" dot for every day of the log', () => {
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['Notes/DBMS exam.md', 'Notes/Normal forms.md', 'Notes/Study plan.md', 'Actions', 'Novi Memory.md']));
    expect(ids.filter((id) => id.startsWith('Actions'))).toEqual(['Actions']);
    expect(g.nodes.find((n) => n.id === 'Notes/DBMS exam.md')).toMatchObject({ title: 'DBMS exam', folder: 'Notes' });
  });

  it('links [[links]] and plain mentions of another title', () => {
    expect(has('Notes/DBMS exam.md', 'Notes/Normal forms.md')).toBe(true);
    expect(has('Notes/Study plan.md', 'Notes/DBMS exam.md')).toBe(true);
    expect(has('Novi Memory.md', 'Actions')).toBe(true);
    expect(has('Notes/Normal forms.md', 'Notes/Study plan.md')).toBe(false);
  });

  it('excerpts are plain text of at most 200 characters, without the front matter', () => {
    for (const n of g.nodes) expect(n.excerpt.length).toBeLessThanOrEqual(200);
    expect(g.nodes.find((n) => n.id === 'Notes/DBMS exam.md').excerpt).not.toContain('created:');
  });
});

describe('readNote: one note for the side panel', () => {
  const vault = vaultWith({ 'Notes/Odd.md': '# Odd\n\n<script>alert(1)</script>' });
  it('returns the Markdown as plain text', () => {
    expect(readNote(vault, 'Notes/Odd.md')).toEqual({ title: 'Odd', text: '# Odd\n\n<script>alert(1)</script>' });
  });
  it('refuses anything outside the vault or not Markdown', () => {
    for (const id of ['../.env', 'Notes/../../.env', '/etc/passwd', 'C:\\Windows\\win.ini', 'Notes/x.txt', '']) {
      expect(() => readNote(vault, id), id).toThrow(/not a note/i);
    }
  });
  it('the whole Actions log reads as one note, newest day first', () => {
    const v = vaultWith({ 'Actions/2026-10-14.md': '- old', 'Actions/2026-10-15.md': '- new' });
    const { text } = readNote(v, 'Actions');
    expect(text.indexOf('new')).toBeLessThan(text.indexOf('old'));
  });
});
