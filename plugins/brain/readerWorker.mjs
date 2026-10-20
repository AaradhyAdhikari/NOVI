// Runs in a worker thread: turns a file into text (plugins/files/readers.js) so big PDFs and Word files
// never hold up Novi's main thread (live 2026-10-20: typed and spoken messages were slow to show up).
import { parentPort } from 'node:worker_threads';
import { readFileText } from '../files/readers.js';

parentPort.on('message', async ({ id, file, max }) => {
  try {
    parentPort.postMessage({ id, text: await readFileText(file, { max }) });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
