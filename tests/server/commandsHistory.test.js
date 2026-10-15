import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistory } from '../../plugins/commands/history.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-hist-')), 'commands', 'history.jsonl');
const entry = (i, extra = {}) => ({ from: 'laptop', level: 'look', purpose: `Check thing ${i}`, command: `Get-Thing ${i}`, ran: true, ok: true, exitCode: 0, output: 'out', ...extra });

describe('commands history', () => {
  it('keeps entries newest first, with the time and only 300 characters of output', () => {
    let t = Date.parse('2026-10-15T10:00:00Z');
    const h = createHistory({ file: tmp(), now: () => new Date(t) });
    h.add(entry(1, { output: 'x'.repeat(1000) }));
    t += 60_000;
    h.add(entry(2));
    const list = h.list();
    expect(list.map((e) => e.purpose)).toEqual(['Check thing 2', 'Check thing 1']);
    expect(list[1].output).toHaveLength(300);
    expect(list[0].at).toBe('2026-10-15T10:01:00.000Z');
  });

  it('keeps the last 500 (rewrites the file after 600)', () => {
    const file = tmp();
    const h = createHistory({ file });
    for (let i = 0; i < 601; i++) h.add(entry(i));
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(500);
    expect(h.list({ limit: 1 })[0].purpose).toBe('Check thing 600');
  });

  it('today filter and the spoken summary', () => {
    let t = Date.parse('2026-10-14T12:00:00');
    const h = createHistory({ file: tmp(), now: () => new Date(t) });
    h.add(entry(0, { purpose: 'Old one' }));
    t = Date.parse('2026-10-15T09:00:00');
    expect(h.summary()).toBe('None today.');
    for (const p of ['Checked free space on D:', 'Listed big files in Downloads', 'Renamed 12 photos']) h.add(entry(0, { purpose: p }));
    h.add(entry(0, { purpose: 'Turn off Defender', ran: false, level: 'never' }));
    expect(h.list({ today: true })).toHaveLength(4);
    expect(h.summary()).toBe('3 today. Last: renamed 12 photos, listed big files in Downloads, checked free space on D:.');
  });

  it('a file it cannot write never throws', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-hist-ro-'));
    fs.writeFileSync(path.join(root, 'commands'), 'a file, not a folder');
    const warned = [];
    const h = createHistory({ file: path.join(root, 'commands', 'history.jsonl'), logger: { warn: (m) => warned.push(m) } });
    expect(() => h.add(entry(1))).not.toThrow();
    expect(warned.length).toBe(1);
    expect(h.list()).toHaveLength(1);
  });
});
