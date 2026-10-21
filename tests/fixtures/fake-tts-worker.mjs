// Stands in for server/voice/edgeTtsWorker.mjs in tests: "audio" = the words, "fail" = an error.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ id, voice, text }) => {
  if (text === 'fail') parentPort.postMessage({ id, error: 'Edge TTS WebSocket error: Unexpected server response: 403' });
  else parentPort.postMessage({ id, audio: new TextEncoder().encode(`${voice}:${text}`) });
});
