// A stand-in for the meaning-model thread: vectors [text length, 1, 0]; dir "broken" = the model won't load.
import { parentPort, workerData } from 'node:worker_threads';
parentPort.on('message', ({ id, cmd, texts }) => {
  if (workerData.dir === 'broken') return parentPort.postMessage({ id, error: 'download failed (503)' });
  if (cmd === 'start') { parentPort.postMessage({ log: '[brain] fake model loaded' }); return parentPort.postMessage({ id, ok: true }); }
  if (cmd === 'crash') process.exit(1);
  const vecs = texts.map((t) => Float32Array.from([t.length, 1, 0]).buffer);
  parentPort.postMessage({ id, vecs }, vecs);
});
