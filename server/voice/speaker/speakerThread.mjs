// The speaker model's thread (speakerWorker.js): one clip in, its voice vector out.
import { parentPort, workerData } from 'node:worker_threads';
import { loadSpeakerVerifier } from './verifier.js';

const loaded = loadSpeakerVerifier({ modelPath: workerData.modelPath });

parentPort.on('message', async ({ id, audio, quit }) => {
  if (quit) return parentPort.close();
  try {
    const { verifier, error } = await loaded;
    if (!verifier) throw new Error(error || 'no speaker model');
    parentPort.postMessage({ id, vector: verifier.embed(audio) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
