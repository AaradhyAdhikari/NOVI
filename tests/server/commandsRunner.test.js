import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRunner, buildScript } from '../../plugins/commands/runner.js';

function fakeSpawn(plan = {}) {
  const children = [];
  const spawnImpl = vi.fn((cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = vi.fn(() => setImmediate(() => c.emit('close', null)));
    Object.assign(c, { cmd, args, opts });
    children.push(c);
    if (plan.out !== undefined || plan.code !== undefined) {
      setImmediate(() => {
        if (plan.out) c.stdout.emit('data', Buffer.from(plan.out));
        if (plan.err) c.stderr.emit('data', Buffer.from(plan.err));
        c.emit('close', plan.code ?? 0);
      });
    }
    return c;
  });
  return { spawnImpl, children };
}
const decode = (args) => Buffer.from(args.at(-1), 'base64').toString('utf16le');
afterEach(() => vi.useRealTimers());

describe('commands runner', () => {
  it('runs hidden PowerShell in the home folder with the script encoded', async () => {
    const { spawnImpl, children } = fakeSpawn({ out: 'C 120 GB free', code: 0 });
    const r = createRunner({ spawnImpl, platform: 'win32', home: 'C:\\Users\\me' });
    const out = await r.run({ command: 'Get-PSDrive C', look: true });
    expect(out).toEqual({ ok: true, exitCode: 0, output: 'C 120 GB free' });
    const c = children[0];
    expect(c.cmd).toBe('powershell.exe');
    expect(c.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    expect(decode(c.args)).toBe(buildScript('Get-PSDrive C', true));
    expect(c.opts).toMatchObject({ cwd: 'C:\\Users\\me', windowsHide: true });
  });

  it('a failed command returns its error; the parser check result is reported', async () => {
    const fail = createRunner({ spawnImpl: fakeSpawn({ err: 'Access is denied.\nmore', code: 1 }).spawnImpl, platform: 'win32', home: 'h' });
    expect(await fail.run({ command: 'x', look: false })).toEqual({ ok: false, exitCode: 1, output: 'Access is denied.\nmore' });
    const notLook = createRunner({ spawnImpl: fakeSpawn({ out: 'NOVI-NOT-LOOK\n', code: 3 }).spawnImpl, platform: 'win32', home: 'h' });
    expect(await notLook.run({ command: 'x', look: true })).toMatchObject({ ok: false, notLook: true });
  });

  it('cuts long output and stops a command that runs too long', async () => {
    const long = createRunner({ spawnImpl: fakeSpawn({ out: 'x'.repeat(9000), code: 0 }).spawnImpl, platform: 'win32', home: 'h' });
    const out = await long.run({ command: 'x', look: false });
    expect(out.output.length).toBeLessThanOrEqual(4010);
    expect(out.output.endsWith('…(cut)')).toBe(true);
    vi.useFakeTimers();
    const { spawnImpl, children } = fakeSpawn();
    const slow = createRunner({ spawnImpl, platform: 'win32', home: 'h', timeoutMs: 60_000 });
    const p = slow.run({ command: 'Start-Sleep 999', look: false });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(children[0].kill).toHaveBeenCalled();
    children[0].emit('close', null);
    expect(await p).toMatchObject({ ok: false, timedOut: true });
  });

  it('refuses off Windows without starting anything', async () => {
    const { spawnImpl } = fakeSpawn();
    await expect(createRunner({ spawnImpl, platform: 'linux', home: 'h' }).run({ command: 'x' })).rejects.toThrow('not-windows');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('look scripts check the command with the PowerShell parser first; others just run it', () => {
    const look = buildScript("Get-Item 'a'", true);
    expect(look).toContain("'Get-Item ''a'''");
    expect(look).toContain('ParseInput');
    expect(look).toContain('NOVI-NOT-LOOK');
    expect(look).toContain('get-childitem'.length ? 'test-path' : '');
    const change = buildScript("Rename-Item 'a' 'b'", false);
    expect(change).not.toContain('ParseInput');
    expect(change).toContain("'Rename-Item ''a'' ''b'''");
  });
});
