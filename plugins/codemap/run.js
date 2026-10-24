import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// graphify's own exe (installed with `uv tool` / pipx into ~/.local/bin, which isn't on the PATH
// Novi starts with); else whatever `graphify` the PATH has.
export function graphifyCommand(configured) {
  if (configured) return configured;
  const exe = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  return fs.existsSync(exe) ? exe : 'graphify';
}

// `graphify update <folder>`: reads the code again (no AI) and rewrites graphify-out/. Runs as its own
// process, so Novi never waits on it (Novi's own map: ~70 s, 2026-10-24). At most `timeoutMs`.
export function runGraphify(folder, { command = graphifyCommand(), spawnImpl = spawn, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnImpl(command, ['update', folder], { cwd: folder, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (err) {
      resolve({ ok: false, error: `graphify didn't start (${err.message})` });
      return;
    }
    const keep = (d) => { out = (out + d).slice(-4000); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.code === 'ENOENT' ? 'graphify is not installed (pip install graphifyy)' : err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
      resolve(code === 0 ? { ok: true, log: out } : { ok: false, error: code === null ? 'graphify took too long' : `graphify stopped: ${last.slice(0, 200)}` });
    });
  });
}
