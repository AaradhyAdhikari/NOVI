import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createControlWorker } from '../../plugins/laptop-control/worker.js';

// A fake PowerShell child: records stdin lines; tests answer with child.reply(obj).
function fakeSpawn() {
  const children = [];
  const spawnImpl = vi.fn((cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.lines = [];
    child.stdin = { write: (s) => { child.lines.push(JSON.parse(s)); return true; } };
    child.kill = vi.fn(() => child.emit('exit', 1));
    child.reply = (obj) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
    child.cmd = cmd; child.args = args; child.opts = opts;
    children.push(child);
    return child;
  });
  return { spawnImpl, children };
}
const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => vi.useRealTimers());

describe('laptop control worker (one PowerShell, JSON lines)', () => {
  it('starts PowerShell hidden on the script and answers each command by id', async () => {
    const { spawnImpl, children } = fakeSpawn();
    const w = createControlWorker({ spawnImpl, script: 'C:\\n\\control.ps1', platform: 'win32' });
    const a = w.run('volume', { delta: 10 });
    const b = w.run('battery');
    await tick();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const c = children[0];
    expect(c.cmd).toBe('powershell.exe');
    expect(c.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\n\\control.ps1']);
    expect(c.opts).toMatchObject({ windowsHide: true });
    expect(c.lines.map((l) => l.cmd)).toEqual(['volume', 'battery']);
    expect(c.lines[0].args).toEqual({ delta: 10 });
    c.reply({ id: c.lines[1].id, ok: true, percent: 72 });
    c.reply({ id: c.lines[0].id, ok: true, level: 40, muted: false });
    expect(await a).toEqual({ level: 40, muted: false });
    expect(await b).toEqual({ percent: 72 });
  });

  it('a failed command rejects with its error; lines may arrive split', async () => {
    const { spawnImpl, children } = fakeSpawn();
    const w = createControlWorker({ spawnImpl, script: 's', platform: 'win32' });
    const p = w.run('brightness', { level: 50 });
    await tick();
    const line = JSON.stringify({ id: children[0].lines[0].id, ok: false, error: 'no-brightness' });
    children[0].stdout.emit('data', Buffer.from(line.slice(0, 10)));
    children[0].stdout.emit('data', Buffer.from(`${line.slice(10)}\n`));
    await expect(p).rejects.toThrow('no-brightness');
  });

  it('refuses off Windows without starting anything', async () => {
    const { spawnImpl } = fakeSpawn();
    const w = createControlWorker({ spawnImpl, script: 's', platform: 'linux' });
    await expect(w.run('battery')).rejects.toThrow('not-windows');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('a hung command times out, the worker is replaced, and the next command works', async () => {
    vi.useFakeTimers();
    const { spawnImpl, children } = fakeSpawn();
    const w = createControlWorker({ spawnImpl, script: 's', platform: 'win32', timeoutMs: 10_000 });
    const p = w.run('radio', { kind: 'wifi', on: false });
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await caught).message).toBe('timeout');
    expect(children[0].kill).toHaveBeenCalled();
    const q = w.run('battery');
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    children[1].reply({ id: children[1].lines[0].id, ok: true, none: true });
    expect(await q).toEqual({ none: true });
  });

  it('if PowerShell exits, waiting commands fail and the next one starts it again', async () => {
    const { spawnImpl, children } = fakeSpawn();
    const w = createControlWorker({ spawnImpl, script: 's', platform: 'win32' });
    const p = w.run('windows');
    await tick();
    children[0].emit('exit', 0);
    await expect(p).rejects.toThrow('worker-exit');
    const q = w.run('battery');
    await tick();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    children[1].reply({ id: children[1].lines[0].id, ok: true, percent: 50 });
    expect(await q).toEqual({ percent: 50 });
  });
});
