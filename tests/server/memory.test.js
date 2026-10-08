import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../../server/memory.js';

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-mem-'));
  file = path.join(dir, 'data', 'memory.json');
});

describe('Memory', () => {
  it('remembers and finds projects exactly and fuzzily', () => {
    const m = new Memory(file);
    const folder = fs.mkdtempSync(path.join(dir, 'Portfolio '));
    expect(m.rememberProject(' Portfolio ', folder)).toEqual({ name: 'portfolio', path: path.resolve(folder) });
    expect(m.findProject('portfolio').path).toBe(path.resolve(folder));
    expect(m.findProject('my portfolio project').name).toBe('portfolio');
    expect(m.findProject('nothing')).toBeNull();
  });

  it('returns null for ambiguous fuzzy matches', () => {
    const m = new Memory(file);
    m.rememberProject('app one', dir);
    m.rememberProject('app two', dir);
    expect(m.findProject('app')).toBeNull();
  });

  it('rejects folders that do not exist', () => {
    const m = new Memory(file);
    expect(() => m.rememberProject('x', path.join(dir, 'missing'))).toThrow(/Folder not found/);
  });

  it('persists across instances and forgets', () => {
    new Memory(file).rememberProject('site', dir);
    const again = new Memory(file);
    expect(again.listProjects().map((p) => p.name)).toEqual(['site']);
    expect(again.forgetProject('SITE')).toBe(true);
    expect(new Memory(file).listProjects()).toEqual([]);
  });

  it('recovers from a corrupt file and keeps a backup', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const m = new Memory(file);
    expect(m.listProjects()).toEqual([]);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('memory.json.corrupt-'))).toBe(true);
  });

  it('caps tasks at 50, newest first, and updates them', () => {
    const m = new Memory(file);
    for (let i = 0; i < 55; i++) m.addTask({ id: `t${i}`, status: 'running' });
    expect(m.data.tasks).toHaveLength(50);
    expect(m.lastTask().id).toBe('t54');
    m.updateTask('t54', { status: 'done', sessionId: 's1' });
    expect(new Memory(file).lastTask()).toMatchObject({ status: 'done', sessionId: 's1' });
  });

  it('lists coding tasks, newest first, as copies', () => {
    const m = new Memory(file);
    m.addTask({ id: 'a', status: 'done' });
    m.addTask({ id: 'b', status: 'failed' });
    const list = m.listTasks();
    expect(list.map((t) => t.id)).toEqual(['b', 'a']);
    list[0].status = 'changed';
    expect(m.listTasks()[0].status).toBe('failed');
  });
});

