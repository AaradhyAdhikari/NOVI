// The freeze watcher's thread (freezeWatch.js). Its own timer also shows whether the whole process stalled.
import inspector from 'node:inspector';
import os from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';
import { whatRan, freezeLine } from './freezeWatch.js';

const { beat, afterMs } = workerData;
const TICK_MS = 100;
const now = () => Date.now() % 2_000_000_000;
let session = null;
let freeze = null; // { startedAt, stalledMs }
let last = Date.now();

const post = (method, params) => new Promise((resolve) => {
  session.post(method, params, (err, result) => resolve(err ? null : result));
});

function begin(silentMs) {
  freeze = { startedAt: Date.now() - silentMs, stalledMs: 0 };
  try {
    session = new inspector.Session();
    session.connectToMainThread();
    // Not awaited: the main thread only answers these when it can, and the watch must go on.
    post('Profiler.enable');
    post('Profiler.setSamplingInterval', { interval: 10000 });
    post('Profiler.start');
  } catch {
    session = null; // the freeze is still logged, just without what ran
  }
}

async function end() {
  const { startedAt, stalledMs } = freeze;
  const ms = Date.now() - startedAt;
  let result = null;
  try {
    if (session) {
      result = await post('Profiler.stop');
      await post('Profiler.disable');
    }
  } finally {
    // Whatever happened: the profiler goes off and the next freeze can be caught.
    try { session?.disconnect(); } catch { /* already gone */ }
    session = null;
    freeze = null;
  }
  parentPort.postMessage({
    log: freezeLine({
      at: new Date(startedAt).toLocaleTimeString('en-GB'), ms, ran: whatRan(result?.profile), stalledMs,
      freeGb: (os.freemem() / 2 ** 30).toFixed(1),
    }),
  });
}

let ending = false;
setInterval(() => {
  const late = Date.now() - last - TICK_MS;
  last = Date.now();
  if (freeze && late > 200) freeze.stalledMs += late;
  const silent = (now() - Atomics.load(beat, 0) + 2_000_000_000) % 2_000_000_000;
  if (!freeze && silent >= afterMs) begin(silent);
  else if (freeze && !ending && silent < afterMs / 2) {
    ending = true;
    end().catch(() => {}).finally(() => { ending = false; });
  }
}, TICK_MS);
