import { Worker } from 'node:worker_threads';

// The meaning model (embed.js) in a worker thread. onnxruntime's run() looks async but holds the thread
// that calls it, so on Novi's main thread it blocked everything else — about 39 s of every 110 s while the
// brain filled (live profile 2026-10-22). Same shape as createEmbedder: ready, starting, broken, start, embed.
export function createWorkerEmbedder({ dir, base, log = () => {}, script = new URL('./embedThread.mjs', import.meta.url) } = {}) {
  let worker = null;
  let seq = 0;
  const waiting = new Map(); // id → { resolve, reject }
  let loading = null;
  let isReady = false;
  let broken = null;
  let failedAt = 0;
  const failAll = (err) => { for (const w of waiting.values()) w.reject(err); waiting.clear(); };
  // A thread that stopped (crash, closed) starts again on the next use.
  const lost = (err) => { failAll(err); worker = null; isReady = false; loading = null; };

  function spawn() {
    worker = new Worker(script, { workerData: { dir, base } });
    worker.unref();
    worker.on('message', (m) => {
      if (m.log) { log(m.log); return; }
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m);
    });
    worker.on('error', (err) => lost(err));
    worker.on('exit', () => lost(new Error('the meaning model stopped')));
  }
  const call = (msg) => {
    if (!worker) spawn();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg });
    });
  };

  return {
    ready: () => isReady,
    starting: () => Boolean(loading) && !isReady && !broken,
    broken: () => broken,
    // Never throws; after a failure it tries again 30 minutes later (as createEmbedder does).
    start() {
      if (broken && Date.now() - failedAt > 30 * 60_000) { loading = null; broken = null; }
      if (!loading) {
        loading = call({ cmd: 'start' }).then(
          () => { isReady = true; return true; },
          (err) => { broken = err.message; failedAt = Date.now(); return null; },
        );
      }
      return loading;
    },
    async embed(texts, kind = 'passage') {
      if (!(await this.start())) return null;
      const { vecs } = await call({ cmd: 'embed', texts, kind });
      return vecs.map((b) => new Float32Array(b));
    },
    close() { failAll(new Error('closed')); worker?.terminate().catch(() => {}); worker = null; },
  };
}
