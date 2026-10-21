// Makes Edge's voice in a worker thread (live 2026-10-21: inside Novi's main thread every request got
// 403 from Microsoft; the same code in a worker, a child process or a script worked).
import { parentPort } from 'node:worker_threads';
import { edgeSynthesize } from './edgeTts.js';

parentPort.on('message', async ({ id, voice, text }) => {
  try {
    const audio = await edgeSynthesize(voice, text);
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength).slice();
    parentPort.postMessage({ id, audio: bytes }, [bytes.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message || String(err) });
  }
});
