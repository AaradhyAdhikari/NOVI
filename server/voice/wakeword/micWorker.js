// The wake-word mic, read in a worker thread. PvRecorder's read() looks async but is a blocking native
// call on the thread that makes it, waiting for the next frame — and when the mic stops sending audio it
// just waits (live 2026-10-22: Novi froze for 97 s; nothing else could run). In a worker only that thread
// waits; Novi stays quick, and a mic quiet for `stallMs` makes read() fail so the listener restarts it.
// Same shape the listener uses: start, read, stop, release, getSelectedDevice.
import { Worker } from 'node:worker_threads';

export function createWorkerRecorder({ Thread = Worker, frameLength, deviceIndex, name = null, stallMs = 5000, maxQueue = 50, workerUrl = new URL('./micThread.mjs', import.meta.url), workerData = {} }) {
  const worker = new Thread(workerUrl, { workerData: { ...workerData, frameLength, deviceIndex } });
  worker.unref();
  const frames = []; // waiting to be read; the oldest go first when the reader falls behind (≤ ~4 s)
  let waiting = null;
  let failed = null;
  let device = name;
  const settle = (fn) => { const w = waiting; waiting = null; clearTimeout(w.timer); fn(w); };
  const fail = (err) => { failed ||= err; if (waiting) settle((w) => w.reject(failed)); };
  worker.on('message', (m) => {
    if (m.device) device = m.device;
    if (m.error) fail(new Error(m.error));
    if (!m.pcm) return;
    const frame = new Int16Array(m.pcm);
    if (waiting) return settle((w) => w.resolve(frame));
    frames.push(frame);
    if (frames.length > maxQueue) frames.shift();
  });
  worker.on('error', fail);
  worker.on('exit', () => fail(new Error('the mic thread stopped')));
  return {
    start() { worker.postMessage('start'); },
    read() {
      if (frames.length) return Promise.resolve(frames.shift());
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting = null; reject(new Error(`the mic sent nothing for ${stallMs / 1000} s`)); }, stallMs);
        waiting = { resolve, reject, timer };
      });
    },
    stop() { worker.postMessage('stop'); },
    // The thread frees the mic itself once its read has returned (freeing it mid-read crashes the
    // process), then ends. One stuck in a read is left to finish: terminate() inside the native read
    // crashes all of Novi too (exit 0xC0000409, live 2026-11-05), and a waiting thread costs nothing.
    release() {
      worker.postMessage('release');
    },
    getSelectedDevice: () => device,
  };
}
