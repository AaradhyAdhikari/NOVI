// Keeps Novi running: starts server/index.js as a child process and restarts it when it
// crashes (growing delays, a long pause in a crash loop). Exit code 75 = restart requested.
// Run with: node server/supervisor.js   (npm start / Start Novi.cmd / the autostart task do this)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RESTART_CODE = 75;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const HEALTHY_MS = 60_000;
const LOOP_WINDOW_MS = 120_000;
const LOOP_CRASHES = 5;
const LOOP_PAUSE_MS = 300_000;

export function createSupervisor({ spawnChild, now = () => Date.now(), logger = console }) {
  let child = null;
  let stopped = false;
  let restarts = 0;
  let backoff = 0;
  let startedAt = 0;
  let timer = null;
  const crashes = [];

  function launch() {
    timer = null;
    if (stopped) return;
    startedAt = now();
    child = spawnChild(restarts);
    child.on('exit', onExit);
  }

  function schedule(ms) {
    restarts += 1;
    timer = setTimeout(launch, ms);
  }

  function onExit(code) {
    child = null;
    if (stopped) return;
    if (code === 0) {
      logger.log('[supervisor] Novi stopped.');
      return;
    }
    if (code === RESTART_CODE) {
      logger.log('[supervisor] restart requested.');
      schedule(0);
      return;
    }
    const t = now();
    if (t - startedAt >= HEALTHY_MS) backoff = 0;
    crashes.push(t);
    while (crashes.length && t - crashes[0] > LOOP_WINDOW_MS) crashes.shift();
    const loop = crashes.length > LOOP_CRASHES;
    const delay = loop ? LOOP_PAUSE_MS : BACKOFF_MS[Math.min(backoff, BACKOFF_MS.length - 1)];
    backoff += 1;
    logger.log(`[supervisor] Novi crashed (exit ${code}); restarting in ${Math.round(delay / 1000)} s${loop ? ' (crash loop: pausing)' : ''}.`);
    schedule(delay);
  }

  return {
    start: launch,
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
    },
  };
}

// Daily log files in data/logs, newest 7 kept.
function openLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir).filter((f) => /^novi-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 6))) fs.rmSync(path.join(dir, old), { force: true });
  return fs.createWriteStream(path.join(dir, `novi-${new Date().toISOString().slice(0, 10)}.log`), { flags: 'a' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const log = openLog(path.join(root, 'data', 'logs'));
  const write = (text) => { process.stdout.write(text); log.write(text); };
  const supervisor = createSupervisor({
    logger: { log: (line) => write(`${new Date().toISOString()} ${line}\n`) },
    spawnChild: (restarts) => {
      const c = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'], {
        cwd: root,
        env: { ...process.env, NOVI_SUPERVISED: '1', NOVI_RESTARTS: String(restarts) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      c.stdout.on('data', (d) => write(String(d)));
      c.stderr.on('data', (d) => write(String(d)));
      return c;
    },
  });
  supervisor.start();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { supervisor.stop(); setTimeout(() => process.exit(0), 3500).unref(); });
}
