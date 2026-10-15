// One long-lived PowerShell (control.ps1) for laptop controls: one JSON line per command on stdin,
// one JSON line back per command ({ id, ok, ...result } or { id, ok: false, error }). Starting
// PowerShell and compiling its C# helpers takes about a second, so it starts once and stays up.
import { spawn } from 'node:child_process';

export function createControlWorker({ spawnImpl = spawn, script, platform = process.platform, timeoutMs = 10_000, logger = console } = {}) {
  let child = null;
  let buffer = '';
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject, timer }

  function settle(id, fn, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p[fn](value);
  }

  function onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { logger.warn?.(`[laptop] odd worker line: ${line.slice(0, 120)}`); return; }
    const { id, ok, error, ...result } = msg;
    if (ok) settle(id, 'resolve', result);
    else settle(id, 'reject', new Error(error || 'failed'));
  }

  function start() {
    const c = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    buffer = '';
    c.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        onLine(line);
      }
    });
    c.stderr?.on('data', (chunk) => logger.warn?.(`[laptop] ${String(chunk).trim().slice(0, 200)}`));
    const gone = () => {
      if (child !== c) return;
      child = null;
      for (const id of [...pending.keys()]) settle(id, 'reject', new Error('worker-exit'));
    };
    c.on('exit', gone);
    c.on('error', gone);
    return c;
  }

  return {
    run(cmd, args = {}) {
      if (platform !== 'win32') return Promise.reject(new Error('not-windows'));
      if (!child) child = start();
      const id = nextId++;
      const c = child;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, 'reject', new Error('timeout'));
          if (child === c) { child = null; for (const other of [...pending.keys()]) settle(other, 'reject', new Error('worker-exit')); }
          try { c.kill(); } catch { /* already gone */ }
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        c.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      });
    },
    stop() {
      const c = child;
      child = null;
      try { c?.kill(); } catch { /* already gone */ }
    },
  };
}
