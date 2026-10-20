import { Worker } from 'node:worker_threads';

// One worker thread that reads files for the second brain, one file at a time. A read that takes longer
// than timeoutMs (a huge or broken PDF) is given up and the worker replaced.
export function createWorkerReader({ timeoutMs = 20_000, max = 60_000, script = new URL('./readerWorker.mjs', import.meta.url) } = {}) {
  let worker = null;
  let seq = 0;
  let restarts = 0;
  const waiting = new Map(); // id → { resolve, reject, timer }
  const failAll = (err) => { for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(err); } waiting.clear(); };

  function start() {
    worker = new Worker(script);
    worker.unref();
    worker.on('message', ({ id, text, error }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      clearTimeout(w.timer);
      if (error) w.reject(new Error(error)); else w.resolve(text);
    });
    worker.on('error', (err) => { failAll(err); worker = null; });
    worker.on('exit', () => { worker = null; });
  }

  return {
    read(file) {
      if (!worker) start();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`reading ${file} took too long`));
          restarts += 1;
          const w = worker;
          worker = null;
          failAll(new Error('the reader was restarted'));
          w?.terminate().catch(() => {});
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        worker.postMessage({ id, file, max });
      });
    },
    restarts: () => restarts,
    close() { failAll(new Error('closed')); worker?.terminate().catch(() => {}); worker = null; },
  };
}
