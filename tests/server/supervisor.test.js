import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSupervisor, RESTART_CODE, createOutput } from '../../server/supervisor.js';

let children;
const spawnChild = (restarts) => {
  const child = new EventEmitter();
  child.restarts = restarts;
  child.kill = () => child.emit('exit', null);
  children.push(child);
  return child;
};
const crash = (code = 1) => children.at(-1).emit('exit', code);

beforeEach(() => { vi.useFakeTimers(); children = []; });
afterEach(() => { vi.useRealTimers(); });

describe('supervisor', () => {
  it('starts Novi once', () => {
    createSupervisor({ spawnChild, logger: { log() {} } }).start();
    expect(children).toHaveLength(1);
    expect(children[0].restarts).toBe(0);
  });

  it('restarts after a crash with growing delays: 1 s, 2 s, 5 s', () => {
    createSupervisor({ spawnChild, logger: { log() {} } }).start();
    crash();
    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    expect(children[1].restarts).toBe(1);
    crash();
    vi.advanceTimersByTime(1999);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);
    crash();
    vi.advanceTimersByTime(5000);
    expect(children).toHaveLength(4);
  });

  it('resets the delay after a minute of healthy running', () => {
    createSupervisor({ spawnChild, logger: { log() {} } }).start();
    crash();
    vi.advanceTimersByTime(1000);
    crash();
    vi.advanceTimersByTime(2000); // third child running
    vi.advanceTimersByTime(61_000); // healthy for over a minute
    crash();
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(4);
  });

  it('restarts at once when Novi asks for a restart (Settings → Restart)', () => {
    createSupervisor({ spawnChild, logger: { log() {} } }).start();
    crash(RESTART_CODE);
    vi.advanceTimersByTime(0);
    expect(children).toHaveLength(2);
  });

  it('force-ends a Novi that freezes while closing for a restart, then starts a new one', () => {
    const log = [];
    createSupervisor({ spawnChild, logger: { log: (l) => log.push(l) }, killAfterMs: 5000 }).start();
    let killed = null;
    children[0].kill = (sig) => { killed = sig; children[0].emit('exit', null); };
    children[0].emit('message', { type: 'restarting' });
    vi.advanceTimersByTime(4999);
    expect(killed).toBe(null);
    vi.advanceTimersByTime(1);
    expect(killed).toBe('SIGKILL');
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    expect(log.join('\n')).toMatch(/froze while closing/);
    expect(log.join('\n')).not.toMatch(/crashed/);
  });

  it('does not kill a Novi that closes by itself after saying it restarts', () => {
    createSupervisor({ spawnChild, logger: { log() {} }, killAfterMs: 5000 }).start();
    let killed = false;
    children[0].kill = () => { killed = true; };
    children[0].emit('message', { type: 'restarting' });
    crash(RESTART_CODE);
    vi.advanceTimersByTime(10_000);
    expect(killed).toBe(false);
    expect(children).toHaveLength(2);
  });

  it('stays stopped when Novi exits normally', () => {
    createSupervisor({ spawnChild, logger: { log() {} } }).start();
    crash(0);
    vi.advanceTimersByTime(600_000);
    expect(children).toHaveLength(1);
  });

  it('waits 5 minutes after a crash loop (more than 5 crashes in 2 minutes)', () => {
    createSupervisor({ spawnChild, logger: { log() {} } }).start();
    for (const delay of [1000, 2000, 5000, 10_000, 30_000]) { crash(); vi.advanceTimersByTime(delay); }
    expect(children).toHaveLength(6);
    crash(); // 6th crash within 2 minutes
    vi.advanceTimersByTime(299_000);
    expect(children).toHaveLength(6);
    vi.advanceTimersByTime(1000);
    expect(children).toHaveLength(7);
  });

  it('stop() ends Novi and does not restart it', () => {
    const sup = createSupervisor({ spawnChild, logger: { log() {} } });
    sup.start();
    sup.stop();
    vi.advanceTimersByTime(600_000);
    expect(children).toHaveLength(1);
  });
});

describe('supervisor output', () => {
  it('always writes the log file, but copies to the console only when there is a real console', () => {
    const logged = [];
    const shown = [];
    const log = { write: (t) => logged.push(t) };
    createOutput({ stdout: { isTTY: true, write: (t) => shown.push(t) }, log })('a');
    // A pipe nobody reads (e.g. started from another tool) would block Novi forever on Windows.
    createOutput({ stdout: { isTTY: false, write: () => { throw new Error('must not write to a pipe'); } }, log })('b');
    expect(logged).toEqual(['a', 'b']);
    expect(shown).toEqual(['a']);
  });
});


describe('uiIsStale (rebuild the screen after a git pull, even on a restart from Settings)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { uiIsStale } = await import('../../server/supervisor.js');
  const touch = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); fs.utimesSync(f, t, t); };

  it('is stale when there is no build, or a source file is newer than the build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ui-'));
    touch(path.join(root, 'src', 'lib', 'a.js'), 1000);
    expect(uiIsStale(root)).toBe(true);
    touch(path.join(root, 'dist', 'index.html'), 2000);
    expect(uiIsStale(root)).toBe(false);
    touch(path.join(root, 'src', 'components', 'b.jsx'), 3000);
    expect(uiIsStale(root)).toBe(true);
  });

  it('checks another build folder when given (the test copy builds into dist-test)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ui-'));
    touch(path.join(root, 'src', 'a.js'), 1000);
    touch(path.join(root, 'dist', 'index.html'), 2000);
    expect(uiIsStale(root, 'dist-test')).toBe(true);
    touch(path.join(root, 'dist-test', 'index.html'), 2000);
    expect(uiIsStale(root, 'dist-test')).toBe(false);
  });
});
