// The PvRecorder mic in its own thread (see micWorker.js): frames go to Novi as they come; a read that
// waits on a quiet mic blocks only this thread.
import { parentPort, workerData } from 'node:worker_threads';
import { PvRecorder } from '@picovoice/pvrecorder-node';

const { frameLength, deviceIndex } = workerData;
let recorder = null;
let loop = null;
let running = false;

try { recorder = new PvRecorder(frameLength, deviceIndex); } catch (err) { parentPort.postMessage({ error: err.message }); }

async function run() {
  while (running) {
    let pcm;
    try { pcm = await recorder.read(); } catch (err) { running = false; parentPort.postMessage({ error: err.message }); break; }
    if (!running) break;
    parentPort.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
  }
}

parentPort.on('message', async (m) => {
  if (!recorder) return;
  if (m === 'start' && !running) {
    try { recorder.start(); } catch (err) { parentPort.postMessage({ error: err.message }); return; }
    running = true;
    parentPort.postMessage({ device: recorder.getSelectedDevice() });
    loop = run();
  }
  if (m === 'stop' || m === 'release') {
    running = false;
    await loop;
    try { recorder.stop(); } catch { /* already stopped */ }
    if (m === 'release') {
      try { recorder.release(); } catch { /* already released */ }
      recorder = null;
      process.exit(0);
    }
  }
});
