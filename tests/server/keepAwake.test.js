import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { startKeepAwake } from '../../server/laptop/keepAwake.js';

function fakeSpawn() {
  const procs = [];
  const spawn = (file, args, opts) => {
    const proc = Object.assign(new EventEmitter(), { file, args, opts, killed: false, kill() { this.killed = true; }, stdin: { end() {} } });
    procs.push(proc);
    return proc;
  };
  return { spawn, procs };
}

describe('startKeepAwake', () => {
  it('holds "don\'t sleep" in a hidden PowerShell (ES_CONTINUOUS | ES_SYSTEM_REQUIRED)', () => {
    const { spawn, procs } = fakeSpawn();
    startKeepAwake({ spawn });
    expect(procs[0].file).toBe('powershell.exe');
    expect(procs[0].opts.windowsHide).toBe(true);
    const script = procs[0].args.join(' ');
    expect(script).toContain('SetThreadExecutionState');
    // PowerShell 5.1 reads 0x80000001 as a negative Int32, so the flag must be an explicit uint32.
    expect(script).toContain('[uint32]2147483649');
  });

  it('stop() ends it', () => {
    const { spawn, procs } = fakeSpawn();
    startKeepAwake({ spawn }).stop();
    expect(procs[0].killed).toBe(true);
  });

  it('restarts once if it dies unexpectedly, not after stop()', () => {
    const { spawn, procs } = fakeSpawn();
    const ka = startKeepAwake({ spawn });
    procs[0].emit('exit', 1);
    expect(procs).toHaveLength(2);
    procs[1].emit('exit', 1);
    expect(procs).toHaveLength(2);
    ka.stop();
    procs[1].emit('exit', 0);
    expect(procs).toHaveLength(2);
  });
});
