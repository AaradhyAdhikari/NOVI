// Starts the always-on "Hey Novi" listener on the laptop microphone, if a wake-word model exists.
import fs from 'node:fs';
import path from 'node:path';
import { createWakeWordDetector } from './detector.js';
import { createWakeListener, normalizeVolume } from './listener.js';
import { encodeWav } from '../../../src/lib/utterance.js';

const DIR = path.resolve('models/wakeword');

// NOVI_WAKEWORD_MIC: a device index or part of its name (e.g. "Realtek"); unset = Windows default.
export function pickMicIndex(devices, value) {
  if (value === undefined || value === '') return -1;
  if (/^-?\d+$/.test(String(value))) return Number(value);
  const i = devices.findIndex((d) => d.toLowerCase().includes(String(value).toLowerCase()));
  return i;
}

export async function startWakeWordService({ novi, env = process.env, logger = console }) {
  const modelPath = path.resolve(env.NOVI_WAKEWORD_MODEL || path.join(DIR, 'hey_novi.onnx'));
  const shared = [path.join(DIR, 'melspectrogram.onnx'), path.join(DIR, 'embedding_model.onnx')];
  const missing = [modelPath, ...shared].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    logger.log(`  Wake word: browser only (missing ${missing.map((f) => path.relative(process.cwd(), f)).join(', ')})`);
    return null;
  }

  const { PvRecorder } = await import('@picovoice/pvrecorder-node');
  const deviceIndex = pickMicIndex(PvRecorder.getAvailableDevices(), env.NOVI_WAKEWORD_MIC);
  const recorder = new PvRecorder(1280, deviceIndex);
  let detector = await createWakeWordDetector({ melspectrogramPath: shared[0], embeddingPath: shared[1], modelPath });
  if (env.NOVI_WAKEWORD_DEBUG) detector = withDebugLog(detector, logger);

  const listener = createWakeListener({
    recorder,
    detector,
    // 0.35: the hey_novi model trained on synthetic voices scored the user's own "Hey Novi" 0.37–0.83 and
    // ordinary commands <= 0.014 (2026-10-07). Override with NOVI_WAKEWORD_THRESHOLD.
    threshold: Number(env.NOVI_WAKEWORD_THRESHOLD || 0.35),
    onWake: (score) => {
      logger.log(`[wake] heard the wake word (${score.toFixed(2)})`);
      novi.broadcast({ type: 'wake' });
    },
    onCommand: (audio) => {
      logger.log(`[wake] command recorded (${(audio.length / 16000).toFixed(1)} s)`);
      novi.runVoiceCommand(Buffer.from(encodeWav(Float32Array.from(normalizeVolume(audio), (s) => s / 32768), 16000)))
        .catch((err) => logger.warn(`[wake] command failed: ${err.message}`));
    },
    onNoCommand: () => {
      logger.log('[wake] no command heard after the wake word');
      novi.broadcast({ type: 'wake_timeout' });
    },
    onError: (err) => {
      logger.warn(`⚠  Wake word stopped: ${err.message}. Falling back to the browser.`);
      novi.setWakeWord('browser');
    },
  });

  listener.start();
  novi.setWakeWord('server');
  logger.log(`  Wake word: always on (${path.basename(modelPath)}, mic: ${recorder.getSelectedDevice()})`);
  return {
    stop() {
      listener.stop();
      try { recorder.release(); } catch { /* already released */ }
    },
  };
}

// NOVI_WAKEWORD_DEBUG=1: log the mic level and best wake score once a second.
function withDebugLog(detector, logger) {
  let peak = 0;
  let best = 0;
  let frames = 0;
  return {
    async process(samples) {
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      const scores = await detector.process(samples);
      for (const v of scores) best = Math.max(best, v);
      if (++frames % 12 === 0) {
        logger.log(`[wake] mic peak ${peak}, best score ${best.toFixed(2)}`);
        peak = 0;
        best = 0;
      }
      return scores;
    },
  };
}
