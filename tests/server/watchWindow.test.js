import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatchWindows } from '../../server/claude/watchWindow.js';

function setup(platform = 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-watch-'));
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, opts }); return { unref() {}, on() {} }; };
  return { dir, runs, w: createWatchWindows({ dir, run, platform, claudeCommand: 'C:\\Users\\A\\.local\\bin\\claude.exe' }) };
}

describe('Claude watch window + take over', () => {
  it('keeps a readable progress log per task', () => {
    const { w, dir } = setup();
    w.append('t1', 'Reading App.jsx');
    w.append('t1', 'Editing App.jsx');
    const log = fs.readFileSync(path.join(dir, 't1.log'), 'utf8');
    expect(log).toMatch(/\d\d:\d\d:\d\d {2}Reading App.jsx\n.*Editing App.jsx\n$/);
  });

  it('opens a Windows Terminal window in the project that follows the log', () => {
    const { w, runs, dir } = setup();
    w.openWatch({ taskId: 't1', project: 'novi', path: 'C:\\code\\novi;x', instruction: 'add dark mode' });
    expect(runs).toHaveLength(1);
    const { cmd, args } = runs[0];
    expect(cmd).toBe('wt.exe');
    expect(args.slice(0, 5)).toEqual(['-w', 'new', '--title', 'Claude · novi', '-d']);
    expect(args[5]).toBe('C:\\code\\novi\\;x'); // wt treats ; as a command separator
    expect(args).toContain('powershell.exe');
    expect(args.at(-1)).toContain(`Get-Content -Wait -Encoding UTF8 -LiteralPath '${path.join(dir, 't1.log')}'`);
    expect(fs.readFileSync(path.join(dir, 't1.log'), 'utf8')).toMatch(/Claude Code is working on novi: add dark mode/);
  });

  it('take over opens interactive Claude Code on the same conversation', () => {
    const { w, runs } = setup();
    w.openTakeOver({ project: 'novi', path: 'C:\\code\\novi', sessionId: 'abc-123' });
    expect(runs[0].args).toEqual(['-w', 'new', '--title', 'Claude · novi', '-d', 'C:\\code\\novi', 'C:\\Users\\A\\.local\\bin\\claude.exe', '--resume', 'abc-123']);
  });

  it('does nothing outside Windows and never throws if Windows Terminal is missing', () => {
    const off = setup('linux');
    off.w.openWatch({ taskId: 't', project: 'p', path: '/p', instruction: 'x' });
    expect(off.runs).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-watch-'));
    const broken = createWatchWindows({ dir, platform: 'win32', claudeCommand: 'claude', run: () => { throw new Error('ENOENT'); } });
    expect(() => broken.openTakeOver({ project: 'p', path: 'C:\\p', sessionId: 's' })).not.toThrow();
  });
});
