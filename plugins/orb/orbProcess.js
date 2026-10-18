import { spawn as nodeSpawn } from 'node:child_process';

// The orb window is a small PowerShell + WPF script (orb.ps1, nothing to install). It talks in JSON
// lines: it sends events on stdout ({ event: 'tap' | 'hold_start' | 'hold_end' | 'moved' | 'open' }),
// Novi sends states on stdin ({ state }). A crash restarts it after 2 / 5 / 15 / 60 s.
const DELAYS = [2000, 5000, 15_000, 60_000];

export function createOrbProcess({ spawn = nodeSpawn, script, place = () => null, onEvent = () => {}, setTimeout: later = setTimeout, logger = console } = {}) {
  let child = null;
  let stopped = false;
  let crashes = 0;
  let startedAt = 0;

  function start() {
    stopped = false;
    const at = place();
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...(at ? ['-X', String(Math.round(at.x)), '-Y', String(Math.round(at.y))] : [])];
    child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    startedAt = Date.now();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        try { onEvent(JSON.parse(line)); } catch { /* not an event line */ }
      }
    });
    child.on('error', (err) => logger.warn?.(`[orb] ${err.message}`));
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      if (Date.now() - startedAt > 5 * 60_000) crashes = 0; // it ran fine for a while
      const wait = DELAYS[Math.min(crashes++, DELAYS.length - 1)];
      logger.warn?.(`[orb] the orb window closed (code ${code}); starting it again in ${wait / 1000} s`);
      later(() => { if (!stopped) start(); }, wait);
    });
  }

  return {
    start,
    send(msg) {
      try { child?.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* the window is gone; it restarts */ }
    },
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}
