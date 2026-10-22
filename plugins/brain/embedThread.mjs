// Runs in a worker thread: the meaning model (embed.js) for the second brain, so its work never holds up
// Novi's main thread (see embedWorker.js).
import { parentPort, workerData } from 'node:worker_threads';
import { createEmbedder } from './embed.js';

const embedder = createEmbedder({ dir: workerData.dir, base: workerData.base, log: (m) => parentPort.postMessage({ log: m }) });

parentPort.on('message', async ({ id, cmd, texts, kind }) => {
  try {
    if (cmd === 'start') {
      if (!(await embedder.start())) throw new Error(embedder.broken() || 'the model did not load');
      parentPort.postMessage({ id, ok: true });
      return;
    }
    if (cmd === 'embed') {
      const vecs = await embedder.embed(texts, kind);
      if (!vecs) throw new Error(embedder.broken() || 'the model did not load');
      const buffers = vecs.map((v) => v.buffer);
      parentPort.postMessage({ id, vecs: buffers }, buffers);
    }
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
