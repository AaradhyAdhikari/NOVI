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

// A project's notes as one group (2026-10-18): "X brief" hangs off "X project", which hangs off
// Novi Memory; a note that mentions nothing else still joins Novi Memory instead of floating alone.
describe('buildGraph: project groups', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-portfolio-'));
  fs.writeFileSync(path.join(folder, 'README.md'), '# Portfolio\n\nMy **site** with a blog.');
  fs.writeFileSync(path.join(folder, 'logo.png'), 'x');
  fs.mkdirSync(path.join(folder, 'public', 'images'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'public', 'images', 'hero.jpg'), 'x');
  fs.mkdirSync(path.join(folder, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules', 'pkg', 'icon.png'), 'x');
  for (const size of ['32', '64', '192', '512']) fs.writeFileSync(path.join(folder, `icon-${size}.png`), 'x');
  const vault = vaultWith({
    'Notes/Portfolio project.md': `# Portfolio project\n\nFolder: ${folder}\nOn claude.ai: https://claude.ai/project/p`,
    'Notes/Portfolio logo ideas.md': '# Portfolio logo ideas\n\nround, blue',
    'Notes/portfolio brief.md': '# portfolio brief\n\n## 2026-10-18\nWhat you asked: a blog',
    'Notes/Groceries.md': '# Groceries\n\nmilk',
  });
  const g = buildGraph(vault);
  const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
  it('brief → project → Novi Memory; lonely notes → Novi Memory', () => {
    expect(has('Notes/portfolio brief.md', 'Notes/Portfolio project.md')).toBe(true);
    // It is on claude.ai, so it hangs off the Claude dot, which hangs off Novi Memory.
    expect(has('Notes/Portfolio project.md', 'Claude')).toBe(true);
    expect(has('Claude', 'Novi Memory.md')).toBe(true);
    expect(has('Notes/portfolio brief.md', 'Novi Memory.md')).toBe(false);
    expect(has('Notes/Groceries.md', 'Novi Memory.md')).toBe(true);
  });
  it('every note named after the project hangs off it', () => {
    expect(has('Notes/Portfolio logo ideas.md', 'Notes/Portfolio project.md')).toBe(true);
  });
  it("at most 3 simple dots per project: Context (README), Pictures (one dot, icon sizes count once), Files", () => {
    const files = g.nodes.filter((n) => n.folder === 'Project files');
    expect(files.map((n) => n.title).sort()).toEqual(['Context', 'Files', 'Pictures']);
    for (const f of files) expect(has(f.id, 'Notes/Portfolio project.md')).toBe(true);
    expect(files.find((n) => n.title === 'Context').excerpt).toBe('Portfolio My site with a blog.');
    expect(files.find((n) => n.title === 'Pictures').excerpt).toBe('3 pictures in Portfolio: logo.png, icon.png, hero.jpg');
    expect(files.find((n) => n.title === 'Files').excerpt).toBe(`7 files in ${folder}`);
  });
  it('the old per-picture check stays out', () => {
    const files = g.nodes.filter((n) => n.folder === 'Project files');
    expect(files.some((n) => /icon-\d+/.test(n.title))).toBe(false);
  });
});

describe('buildGraph: a project whose folder came later', () => {
  it('reads the newest Folder: line, and Context: folders add their files too', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-flexr-'));
    fs.writeFileSync(path.join(a, 'README.md'), '# FLEXR\n\nFitness app.');
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-flexr-ctx-'));
    fs.writeFileSync(path.join(b, 'notes.txt'), 'x');
    const vault = vaultWith({ 'Notes/FLEXR project.md': `# FLEXR project\n\nOn claude.ai: https://claude.ai/project/f\nNo folder on the laptop yet.\n\nFolder: ${a}\n\nContext: ${b}` });
    const g = buildGraph(vault);
    const dots = g.nodes.filter((n) => n.folder === 'Project files').map((n) => `${n.title}: ${n.excerpt}`);
    expect(dots).toContain('Context: FLEXR Fitness app.');
    expect(dots).toContain(`Files: 1 file in ${a}`);
    expect(dots).toContain(`Files: 1 file in ${b}`);
  });
});

describe('buildGraph: a Claude dot', () => {
  it('every project on claude.ai hangs off one "Claude" dot, which hangs off Novi Memory', () => {
    const vault = vaultWith({
      'Notes/FLEXR project.md': '# FLEXR project\n\nOn claude.ai: https://claude.ai/project/f\nNo folder on the laptop yet.',
      'Notes/TraceBites project.md': '# TraceBites project\n\nOn claude.ai: https://claude.ai/project/t',
      'Notes/Calc project.md': '# Calc project\n\nFolder: /nope',
    });
    const g = buildGraph(vault);
    const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
    expect(g.nodes.find((n) => n.id === 'Claude')).toMatchObject({ title: 'Claude', folder: 'Claude', excerpt: 'Your 2 projects on claude.ai: FLEXR, TraceBites' });
    expect(has('Notes/FLEXR project.md', 'Claude')).toBe(true);
    expect(has('Claude', 'Novi Memory.md')).toBe(true);
    expect(has('Notes/FLEXR project.md', 'Novi Memory.md')).toBe(false);
    expect(has('Notes/Calc project.md', 'Novi Memory.md')).toBe(true);
  });
});

describe('buildGraph: a ChatGPT dot (user, 2026-10-20: ChatGPT plans, Claude builds)', () => {
  it('the planning chat note and every brief ChatGPT planned hang off one "ChatGPT" dot', () => {
    const vault = vaultWith({
      'Notes/ChatGPT plan.md': '# ChatGPT plan\n\n## 2026-10-20\nNew from ChatGPT: brain tidy-up',
      'Notes/Portfolio project.md': '# Portfolio project\n\nFolder: /nope',
      'Notes/Portfolio brief.md': '# Portfolio brief\n\n## 2026-10-18\nGoal: a blog',
      'Notes/Groceries.md': '# Groceries\n\nmilk',
    });
    const g = buildGraph(vault);
    const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
    expect(g.nodes.find((n) => n.id === 'ChatGPT')).toMatchObject({ title: 'ChatGPT', folder: 'ChatGPT', excerpt: 'On ChatGPT: your planning chat (ChatGPT plan) and 1 project brief (Portfolio). Claude builds them.' });
    expect(has('ChatGPT', 'Novi Memory.md')).toBe(true);
    expect(has('Notes/ChatGPT plan.md', 'ChatGPT')).toBe(true);
    expect(has('Notes/ChatGPT plan.md', 'Novi Memory.md')).toBe(false);
    expect(has('Notes/Portfolio brief.md', 'ChatGPT')).toBe(true);
    expect(has('Notes/Portfolio brief.md', 'Notes/Portfolio project.md')).toBe(true);
    expect(has('Notes/Groceries.md', 'ChatGPT')).toBe(false);
  });

  it('no plan and no brief: no ChatGPT dot', () => {
    const g = buildGraph(vaultWith({ 'Notes/Groceries.md': '# Groceries\n\nmilk' }));
    expect(g.nodes.some((n) => n.id === 'ChatGPT')).toBe(false);
  });
});
