import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileIndex, defaultRoots, queryOf } from '../../plugins/files/fileIndex.js';

function laptop() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-files-'));
  const put = (rel, days = 100) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    const t = (Date.now() - days * 86400000) / 1000;
    fs.utimesSync(p, t, t);
    return p;
  };
  put('Documents/College/DBMS Notes.docx', 3);
  put('Documents/College/dbms-notes-old.pdf', 200);
  put('Documents/Sales Analysis 2026.xlsx', 2);
  put('Downloads/sales_analysis_draft.csv', 50);
  put('Projects/calc/index.html', 1);
  put('Projects/calc/node_modules/lib/notes.md');
  put('AppData/Local/thing/notes.txt');
  put('Pictures/trip photo.jpg', 10);
  put('Documents/random.exe');
  return root;
}

describe('file index (whole laptop, smart)', () => {
  it('lists documents, sheets, code and folders, skipping app/system folders and unknown types', async () => {
    const root = laptop();
    const index = createFileIndex({ roots: [root], home: root, file: path.join(root, 'index.json') });
    await index.build();
    const all = index.entries().map((e) => path.relative(root, e.path));
    expect(all).toEqual(expect.arrayContaining([path.join('Documents', 'College', 'DBMS Notes.docx'), path.join('Projects', 'calc', 'index.html'), path.join('Projects', 'calc')]));
    expect(all.some((p) => p.includes('node_modules') || p.includes('AppData') || p.endsWith('.exe'))).toBe(false);
  });

  it('finds what was said, even misheard, preferring the kind asked for and recent files', async () => {
    const root = laptop();
    const index = createFileIndex({ roots: [root], home: root, file: path.join(root, 'index.json') });
    await index.build();
    const top = (q) => path.basename(index.search(q)[0]?.path || '');
    expect(top('open my DBMS notes')).toBe('DBMS Notes.docx');
    expect(top('the dbms notes pdf')).toBe('dbms-notes-old.pdf');
    expect(top('summarize the sales analysis sheet')).toBe('Sales Analysis 2026.xlsx');
    expect(top('sails analisis')).toBe('Sales Analysis 2026.xlsx');
    expect(top('trip photo')).toBe('trip photo.jpg');
    expect(top('calc folder')).toBe('calc');
    expect(index.search('quantum physics thesis')).toEqual([]);
  });

  it('saves the list so it is ready right after a restart', async () => {
    const root = laptop();
    const file = path.join(root, 'index.json');
    await createFileIndex({ roots: [root], home: root, file }).build();
    const again = createFileIndex({ roots: [root], home: root, file });
    expect(again.load()).toBe(true);
    expect(path.basename(again.search('dbms notes')[0].path)).toBe('DBMS Notes.docx');
  });

  it('roots: every drive on Windows, the home folder elsewhere', () => {
    expect(defaultRoots({ platform: 'win32', home: 'C:\\Users\\A', exists: (p) => ['C:\\', 'D:\\'].includes(p) })).toEqual(['C:\\', 'D:\\']);
    expect(defaultRoots({ platform: 'linux', home: '/home/a', exists: () => true })).toEqual(['/home/a']);
  });

  it('queryOf drops the command words', () => {
    expect(queryOf('please open my DBMS notes file')).toEqual({ words: ['dbms', 'notes'], kind: null });
    expect(queryOf('summarize the sales analysis sheet')).toEqual({ words: ['sales', 'analysis'], kind: 'sheet' });
  });
});
