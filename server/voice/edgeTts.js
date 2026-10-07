// Natural voices for Novi's replies: Microsoft Edge's online neural voices (free, no key), via msedge-tts.
// It is an unofficial service that could stop working, so every caller falls back to a local voice.
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

async function edgeSynthesize(voice, text) {
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
export function createEdgeTts({ voices = DEFAULT_VOICES, synthesize = edgeSynthesize, timeoutMs = 10_000 } = {}) {
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
