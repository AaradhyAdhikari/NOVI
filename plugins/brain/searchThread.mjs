// Runs in a worker thread: second-brain searches on their own connection to brain.db (see searchWorker.js).
import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from './store.js';
import { fusedSearch } from './search.js';

const store = openStore(workerData.file, { refreshMs: 10 * 60_000 });
// The meaning vectors are loaded once now, so the first search is quick too.
setTimeout(() => { try { store.nearest(new Float32Array(384), 1); } catch { /* no vectors yet */ } }, 0);

parentPort.on('message', ({ id, query, qv, project, limit, minSim }) => {
  try {
    parentPort.postMessage({ id, hits: fusedSearch(store, query, qv ? new Float32Array(qv) : null, { project, limit, minSim }) });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
