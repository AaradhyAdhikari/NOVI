import { Worker } from 'node:worker_threads';

// Freezes of 20–35 s came and went on 2026-11-04 and couldn't be made to happen on demand, so this catches
// them in the act: a thread watches Novi's heartbeat, and when the main thread stops it records what was
// running. The log then says which function it was, or that the whole laptop stalled.
export function startFreezeWatch({ logger = console, afterMs = 2000, beatMs = 100, script = new URL('./freezeThread.mjs', import.meta.url) } = {}) {
  const beat = new Int32Array(new SharedArrayBuffer(4));
  const stamp = () => Atomics.store(beat, 0, Date.now() % 2_000_000_000);
  stamp();
  const timer = setInterval(stamp, beatMs);
  timer.unref?.();
  const worker = new Worker(script, { workerData: { beat, afterMs } });
  worker.unref();
  worker.on('message', (m) => { if (m.log) logger.warn?.(m.log); });
  worker.on('error', (err) => logger.warn?.(`[freeze] the watcher stopped: ${err.message}`));
  return { stop() { clearInterval(timer); return worker.terminate(); } };
}

// A CPU profile → the Novi functions that took the time, longest first.
export function whatRan(profile, top = 4) {
  const byId = new Map((profile?.nodes || []).map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of byId.values()) for (const c of n.children || []) parent.set(c, n.id);
  const short = (url) => String(url).replace(/^.*?\/(server|plugins|node_modules)\//, '$1/');
  const label = (n) => `${n.callFrame.functionName || '(anon)'} ${short(n.callFrame.url)}`.trim();
  const owner = (id) => {
    for (let c = id; c; c = parent.get(c)) {
      const n = byId.get(c);
      if (/\/(server|plugins)\//.test(n.callFrame.url) && !/node_modules/.test(n.callFrame.url)) return label(n);
    }
    return label(byId.get(id));
  };
  const time = new Map();
  (profile?.samples || []).forEach((id, i) => {
    if (/^\((idle|program)\)$/.test(byId.get(id)?.callFrame.functionName)) return;
    const who = owner(id);
    time.set(who, (time.get(who) || 0) + (profile.timeDeltas[i] || 0) / 1e6);
  });
  return [...time].sort((a, b) => b[1] - a[1]).slice(0, top).filter(([, s]) => s >= 0.05).map(([who, s]) => `${who} ${s.toFixed(1)}s`);
}

export function freezeLine({ at, ms, ran, stalledMs, freeGb }) {
  const seconds = (ms / 1000).toFixed(1);
  const what = ran.length ? ran.join(', ') : 'no JavaScript ran (a native call, or the process wasn\'t running)';
  const whole = stalledMs >= 1000 ? `; the watcher stalled ${(stalledMs / 1000).toFixed(1)} s too, so the whole process or laptop stopped` : '';
  return `[freeze] ${at}: ${seconds} s. ${what}${whole}. Free memory ${freeGb} GB.`;
}
