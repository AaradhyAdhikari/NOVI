import { Worker } from 'node:worker_threads';

// The speaker model in its own thread: computing a voice took up to a second on Novi's main thread for
// every clip (live profile 2026-11-04), and everything else waited behind it. A check that fails or takes
// too long just rejects: the caller then treats the voice as unchecked, so Novi never goes deaf.
export function createSpeakerWorker({ modelPath, script = new URL('./speakerThread.mjs', import.meta.url), timeoutMs = 5000 }) {
  let worker = null;
  let seq = 0;
  const waiting = new Map(); // id → { resolve, reject, timer }
  const settle = (id) => {
    const w = waiting.get(id);
    if (w) { clearTimeout(w.timer); waiting.delete(id); }
    return w;
  };
  const lost = (err) => {
    for (const id of [...waiting.keys()]) settle(id).reject(err);
    worker = null;
  };
  function spawn() {
    const thread = new Worker(script, { workerData: { modelPath } });
    thread.unref();
    thread.on('message', (m) => {
      const w = settle(m.id);
      if (!w) return;
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.vector);
    });
    thread.on('error', (err) => { if (worker === thread) lost(err); });
    thread.on('exit', () => { if (worker === thread) lost(new Error('the speaker model stopped')); });
    worker = thread;
  }
  return {
    // Loads the model now, so the first clip doesn't wait for it.
    start() {
      if (!worker) spawn();
    },
    // 16-bit samples → the voice's vector.
    embed(audio) {
      if (!worker) spawn();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        // A stuck clip would hold up every clip after it, so its thread goes and the next clip starts a new one.
        const timer = setTimeout(() => {
          settle(id);
          reject(new Error('the voice check took too long'));
          const stuck = worker;
          worker = null;
          stuck?.terminate();
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        worker.postMessage({ id, audio: Int16Array.from(audio) });
      });
    },
    stop() {
      const thread = worker;
      worker = null;
      return thread?.terminate();
    },
  };
}
