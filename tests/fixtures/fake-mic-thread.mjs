// A stand-in for the PvRecorder mic thread: frames of a known value every 10 ms, or none ("stall").
import { parentPort, workerData } from 'node:worker_threads';
let timer = null;
let n = 0;
parentPort.on('message', (m) => {
  if (m === 'start') {
    parentPort.postMessage({ device: 'Fake mic' });
    if (workerData.mode === 'stall') return;
    timer = setInterval(() => { n += 1; const pcm = new Int16Array(workerData.frameLength).fill(n); parentPort.postMessage({ pcm: pcm.buffer }, [pcm.buffer]); }, 10);
  }
  if (m === 'stop' || m === 'release') { clearInterval(timer); if (m === 'release') parentPort.postMessage({ released: true }); }
});
