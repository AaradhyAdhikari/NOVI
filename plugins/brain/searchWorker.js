import { Worker } from 'node:worker_threads';

// The second brain's search in a worker thread with its own read-only use of brain.db. On Novi's main
// thread one search over 350k passages held everything for 7–10 s before the AI could start (live
// 2026-10-22: "open my github profile" took 27 s). The query's meaning vector comes from the model
// worker; this thread does the word search, the meaning search and the fusing.
export function createSearchWorker({ file, script = new URL('./searchThread.mjs', import.meta.url) } = {}) {
  let worker = null;
  let seq = 0;
  const waiting = new Map(); // id → { resolve, reject }
  const failAll = (err) => { for (const w of waiting.values()) w.reject(err); waiting.clear(); };
  function spawn() {
    worker = new Worker(script, { workerData: { file } });
    worker.unref();
    worker.on('message', ({ id, hits, error }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      if (error) w.reject(new Error(error)); else w.resolve(hits);
    });
    worker.on('error', (err) => { failAll(err); worker = null; });
    worker.on('exit', () => { failAll(new Error('the brain search stopped')); worker = null; });
  }
  return {
    start() { if (!worker) spawn(); },
    search({ query, qv = null, project = null, limit = 6, minSim } = {}) {
      if (!worker) spawn();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        const vec = qv ? Float32Array.from(qv) : null;
        worker.postMessage({ id, query, qv: vec?.buffer || null, project, limit, minSim }, vec ? [vec.buffer] : []);
      });
    },
    close() { failAll(new Error('closed')); worker?.terminate().catch(() => {}); worker = null; },
  };
}
