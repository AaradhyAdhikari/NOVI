// Natural voices for Novi's replies: Microsoft Edge's online neural voices (free, no key), via msedge-tts.
// It is an unofficial service that could stop working, so every caller falls back to a local voice.
import { Worker } from 'node:worker_threads';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const DEFAULT_VOICES = { en: 'en-IN-NeerjaNeural', hi: 'hi-IN-SwaraNeural', mr: 'mr-IN-AarohiNeural' };
const MAX_CHARS = 1500;

// Words that tell Marathi and Hindi apart (both are written in Devanagari).
const MARATHI = new Set('आहे आहेत नाही मला तुम्ही तुला आणि झाले किती वाजले उद्या करून दाखव लाव पुण्यात सकाळी उठव हवामान आम्ही त्याचा तिचा कसं काय'.split(' '));
const HINDI = new Set('है हैं नहीं मुझे आप और क्या में का की के को से देना मौसम हम उसका कैसे'.split(' '));

export function pickVoice(text, voices = DEFAULT_VOICES) {
  if (!/[ऀ-ॿ]/.test(text)) return voices.en;
  const words = String(text).split(/[\s,.!?।"'()]+/);
  const mr = words.filter((w) => MARATHI.has(w)).length;
  const hi = words.filter((w) => HINDI.has(w)).length;
  return mr > hi ? voices.mr : voices.hi;
}

// Used inside the worker thread (edgeTtsWorker.mjs); Novi itself calls createWorkerSynthesize.
export async function edgeSynthesize(voice, text) {
  const tts = new MsEdgeTTS();
  try {
    // The third argument works around a msedge-tts bug when the voice changes.
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error('Edge TTS returned no audio');
    return audio;
  } finally {
    tts.close?.();
  }
}

// Returns (text) => Promise<Buffer> of MP3 audio. Voices can be changed in .env:
// NOVI_TTS_VOICE_EN / NOVI_TTS_VOICE_HI / NOVI_TTS_VOICE_MR.
// The voice made in a worker thread (live 2026-10-21: in Novi's main thread every Edge request got 403,
// while the same code in a worker worked). One worker, started on first use and again after a crash.
export function createWorkerSynthesize({ workerUrl = new URL('./edgeTtsWorker.mjs', import.meta.url) } = {}) {
  let worker = null;
  let next = 0;
  const pending = new Map();
  const failAll = (err) => { for (const { reject } of pending.values()) reject(err); pending.clear(); };
  const start = () => {
    worker = new Worker(workerUrl);
    worker.unref();
    worker.on('message', ({ id, audio, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(Buffer.from(audio));
    });
    worker.on('error', (err) => { failAll(err); worker = null; });
    worker.on('exit', () => { failAll(new Error('Edge TTS worker stopped')); worker = null; });
  };
  const synthesize = (voice, text) => new Promise((resolve, reject) => {
    if (!worker) start();
    const id = (next += 1);
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, voice, text });
  });
  synthesize.close = () => { worker?.terminate(); worker = null; };
  return synthesize;
}
let shared = null;
const workerSynthesize = (voice, text) => (shared ||= createWorkerSynthesize())(voice, text);

export function createEdgeTts({ voices = DEFAULT_VOICES, synthesize = workerSynthesize, timeoutMs = 10_000 } = {}) {
  return async (text) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!clean) throw new Error('Nothing to say');
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Edge TTS timed out')), timeoutMs); });
    try {
      return await Promise.race([synthesize(pickVoice(clean, voices), clean), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
