// Stands in for speakerThread.mjs: a clip starting with 1 answers, 2 fails, 3 never answers, 4 crashes.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, audio }) => {
  if (audio[0] === 1) parentPort.postMessage({ id, vector: Float32Array.from([audio.length, 2]) });
  if (audio[0] === 2) parentPort.postMessage({ id, error: 'too short' });
  if (audio[0] === 4) throw new Error('crashed');
});
