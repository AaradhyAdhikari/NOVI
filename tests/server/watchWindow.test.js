import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatchWindows } from '../../server/claude/watchWindow.js';

function setup(platform = 'win32', exists = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-watch-'));
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, opts }); return { unref() {}, on() {} }; };
  return { dir, runs, w: createWatchWindows({ dir, run, platform, exists, claudeCommand: 'C:\\Users\\A\\.local\\bin\\claude.exe' }) };
}

describe('Claude watch window + take over', () => {
  it('keeps a readable progress log per task', () => {
    const { w, dir } = setup();
    w.append('t1', 'Reading App.jsx');
    w.append('t1', 'Editing App.jsx');
    const log = fs.readFileSync(path.join(dir, 't1.log'), 'utf8');
    expect(log).toMatch(/\d\d:\d\d:\d\d {2}Reading App.jsx\n.*Editing App.jsx\n$/);
  });

  it('take over opens interactive Claude Code on the same conversation', () => {
    const { w, runs } = setup();
    w.openTakeOver({ project: 'novi', path: 'C:\\code\\novi', sessionId: 'abc-123' });
    expect(runs[0].args).toEqual(['-w', 'new', '--title', 'Claude · novi', '-d', 'C:\\code\\novi', 'C:\\Users\\A\\.local\\bin\\claude.exe', '--resume', 'abc-123']);
  });

  it('a project folder that no longer exists: take over says so', () => {
    const { w, runs } = setup('win32', () => false);
    expect(w.openTakeOver({ project: 'gone', path: 'C:\\Temp\\gone', sessionId: 's' })).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('does nothing outside Windows and never throws if Windows Terminal is missing', () => {
    const off = setup('linux');
    off.w.openTakeOver({ project: 'p', path: '/p', sessionId: 's' });
    expect(off.runs).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-watch-'));
    const broken = createWatchWindows({ dir, platform: 'win32', claudeCommand: 'claude', run: () => { throw new Error('ENOENT'); } });
    expect(() => broken.openTakeOver({ project: 'p', path: 'C:\\p', sessionId: 's' })).not.toThrow();
  });
});
