import { Worker } from 'node:worker_threads';

// The speaker model in its own thread: computing a voice took up to a second on Novi's main thread for
// every clip (live profile 2026-11-04), and everything else waited behind it. A check that fails or takes
// too long just rejects: the caller then treats the voice as unchecked, so Novi never goes deaf.
const MAX_STUCK = 2;

export function createSpeakerWorker({ modelPath, script = new URL('./speakerThread.mjs', import.meta.url), timeoutMs = 5000, Thread = Worker }) {
  let worker = null;
  let seq = 0;
  let stuckThreads = 0; // asked to quit, still inside a clip; each holds a loaded model
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
    const thread = new Thread(script, { workerData: { modelPath } });
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
      if (!worker) {
        if (stuckThreads >= MAX_STUCK) return Promise.reject(new Error('the voice check is stuck'));
        spawn();
      }
      const thread = worker;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        // A stuck clip would hold up every clip after it, so the next clip starts a new thread. The old one is
        // asked to quit once its clip is done: terminate() inside the model's native code crashes all of Novi
        // (exit 0xC0000409, live 2026-11-05, and it took a running Claude task with it).
        const timer = setTimeout(() => {
          settle(id);
          reject(new Error('the voice check took too long'));
          if (worker !== thread) return; // already replaced: the new thread is not the stuck one
          worker = null;
          stuckThreads += 1;
          thread.on('exit', () => { stuckThreads -= 1; });
          thread.postMessage({ quit: true });
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        thread.postMessage({ id, audio: Int16Array.from(audio) });
      });
    },
    stop() {
      const thread = worker;
      worker = null;
      return thread?.terminate();
    },
  };
}
