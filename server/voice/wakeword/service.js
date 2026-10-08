// Starts the always-on "Hey Novi" listener on the laptop microphone, if a wake-word model exists.
import fs from 'node:fs';
import path from 'node:path';
import { createWakeWordDetector } from './detector.js';
import { createWakeListener, normalizeVolume } from './listener.js';
import { encodeWav } from '../../../src/lib/utterance.js';
import { spokenText } from '../../narrator.js';
import { loadSpeakerVerifier } from '../speaker/verifier.js';

const DIR = path.resolve('models/wakeword');
const SPEAKER_MODEL = path.resolve('models/speaker/wespeaker_en_voxceleb_resnet34.onnx');

// "Only my voice" + "Hey Novi" interrupts: the listener asks Novi whether a voice is the owner's
// (true / false / null = check off) and silences Novi when the owner interrupts it.
export function speakerOptions({ novi, env, logger }) {
  return {
    checkSpeaker: (audio) => (novi.checkVoice ? novi.checkVoice(audio).ok : null),
    interruptThreshold: env.NOVI_WAKEWORD_INTERRUPT_THRESHOLD ? Number(env.NOVI_WAKEWORD_INTERRUPT_THRESHOLD) : null,
    onRejected: ({ score }) => {
      if (env.NOVI_WAKEWORD_DEBUG) logger.log(`[wake] not the owner's voice (wake score ${score.toFixed(2)}), ignored`);
    },
    onInterrupt: () => {
      logger.log('[wake] interrupted: stopped talking, listening');
      novi.stopSpeaking?.();
      novi.broadcast?.({ type: 'wake' });
    },
  };
}

// Unset NOVI_WAKEWORD_MIC: connected earphones / a headset (Bluetooth or wired) first, then any
// other external mic, else the Windows default. Set it to a device index or part of its name
// (e.g. "Realtek") to always use that one.
const HEADSET = /headset|headphone|earphone|earbud|\bbuds?\b|airpods|hands-?free|bluetooth|\bbt\b/i;
const BUILT_IN = /microphone array|realtek|intel|smart sound|internal|built-?in|stereo mix/i;

export function pickMicIndex(devices, value) {
  if (value === undefined || value === '') {
    const headset = devices.findIndex((d) => HEADSET.test(d));
    if (headset >= 0) return headset;
    return devices.findIndex((d) => !BUILT_IN.test(d)); // -1 = Windows default
  }
  if (/^-?\d+$/.test(String(value))) return Number(value);
  const i = devices.findIndex((d) => d.toLowerCase().includes(String(value).toLowerCase()));
  return i;
}

export function micToUse(devices, value) {
  const index = pickMicIndex(devices, value);
  return { index, name: index >= 0 ? devices[index] : 'default' };
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
  let detector = await createWakeWordDetector({ melspectrogramPath: shared[0], embeddingPath: shared[1], modelPath });
  if (env.NOVI_WAKEWORD_DEBUG) detector = withDebugLog(detector, logger);
  const speaker = await loadSpeakerVerifier({ modelPath: path.resolve(env.NOVI_SPEAKER_MODEL || SPEAKER_MODEL) });
  if (speaker.status === 'error') logger.warn(`⚠  Voice check off: the speaker model failed to load (${speaker.error}).`);
  novi.setSpeakerVerifier?.(speaker);
  const voiceCheck = { ready: 'ready', 'no-model': 'no model', error: 'error' }[speaker.status];

  // 0.35: the hey_novi model trained on synthetic voices; override with NOVI_WAKEWORD_THRESHOLD.
  // A level chosen in Settings → "Hey Novi" from the user's own clips wins over the default.
  let level = Number(env.NOVI_WAKEWORD_THRESHOLD || novi.wakeThreshold?.() || 0.35);
  let current = null; // { recorder, listener } — replaced on every (re)start

  // A fresh mic each start: follows whichever mic Windows uses now (earbuds in or out).
  async function start({ onError }) {
    const mic = micToUse(PvRecorder.getAvailableDevices(), env.NOVI_WAKEWORD_MIC);
    const recorder = new PvRecorder(1280, mic.index);
    const listener = createWakeListener({
      recorder,
      detector,
      threshold: level,
      ...speakerOptions({ novi, env, logger }),
      onWake: (score) => {
        logger.log(`[wake] heard the wake word (${score.toFixed(2)})`);
        novi.broadcast({ type: 'wake' });
      },
      onCommand: async (audio, { followUp } = {}) => {
        logger.log(`[wake] ${followUp ? 'follow-up' : 'command'} recorded (${(audio.length / 16000).toFixed(1)} s)`);
        try {
          const result = await novi.runVoiceCommand(Buffer.from(encodeWav(Float32Array.from(normalizeVolume(audio), (s) => s / 32768), 16000)));
          // Conversation mode: keep listening for the next sentence, no "Hey Novi" needed.
          const next = result && conversationNext(result);
          if (next && current?.listener === listener) {
            listener.followUp(next);
            novi.broadcast({ type: 'wake' });
          }
        } catch (err) {
          logger.warn(`[wake] command failed: ${err.message}`);
        }
      },
      onNoCommand: ({ followUp } = {}) => {
        logger.log(followUp ? '[wake] conversation ended (quiet)' : '[wake] no command heard after the wake word');
        novi.broadcast({ type: 'wake_timeout' });
      },
      onError: (err) => {
        try { recorder.release(); } catch { /* already released */ }
        onError(err);
      },
    });
    current = { recorder, listener, mic: mic.name, onError };
    listener.start();
    novi.setWakeWord('server');
    // Settings → "Hey Novi": record practice clips through this mic and change the level live.
    novi.setWakeTools?.({
      capture: (ms) => current.listener.capture(ms),
      setThreshold: (value) => { level = value; current.listener.setThreshold(value); },
      threshold: level,
      setSpeaking: (on) => current?.listener.setSpeaking(on),
    });
    logger.log(`  Wake word: always on (${path.basename(modelPath)}, level ${level}, mic: ${recorder.getSelectedDevice()}, voice check model: ${voiceCheck})`);
  }

  const runner = keepRestarting({ start, logger });
  await runner.begin();
  // Earphones plugged in or unplugged: switch to the mic that should be used now.
  const micCheck = setInterval(() => {
    let want;
    try { want = micToUse(PvRecorder.getAvailableDevices(), env.NOVI_WAKEWORD_MIC); } catch { return; }
    if (!current || want.name === current.mic) return;
    logger.log(`[wake] switching mic: ${current.mic} → ${want.name}`);
    const old = current;
    old.listener.stop();
    try { old.recorder.release(); } catch { /* already released */ }
    start({ onError: old.onError }).catch((err) => old.onError(err));
  }, 10_000);
  micCheck.unref?.();
  return {
    stop() {
      clearInterval(micCheck);
      runner.stop();
      current?.listener.stop();
      try { current?.recorder.release(); } catch { /* already released */ }
    },
  };
}

// Replies that end a conversation; anything else keeps Novi listening for ~8 s after it speaks.
const ENDS = /^(stop|bye|goodbye|good night|thanks|thank you|that's all|that is all|nothing|no thanks|okay bye|ok bye)\b/i;
const SPEECH_START_MS = 1500; // making the voice + starting to play
const MS_PER_CHAR = 70; // ~14 characters a second

export function conversationNext({ text = '', reply = '' } = {}) {
  if (!String(text).trim() || !String(reply).trim() || ENDS.test(String(text).trim())) return null;
  return { deafMs: SPEECH_START_MS + spokenText(reply).length * MS_PER_CHAR, waitMs: 8000 };
}

// The laptop mic can fail (earbuds connecting, another app, a driver hiccup). Never give up:
// start it again after a short wait, a little longer each time.
export function keepRestarting({ start, delays = [1000, 2000, 5000, 10000, 30000], logger = console }) {
  let stopped = false;
  let failures = 0;
  let timer = null;
  const run = async () => {
    if (stopped) return;
    try {
      await start({ onError });
    } catch (err) {
      onError(err);
    }
  };
  function onError(err) {
    if (stopped) return;
    const wait = delays[Math.min(failures, delays.length - 1)];
    failures += 1;
    logger.warn(`⚠  Wake-word mic stopped (${err.message}). Starting it again in ${wait / 1000} s.`);
    timer = setTimeout(run, wait);
  }
  return {
    begin: run,
    stop() {
      stopped = true;
      clearTimeout(timer);
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
