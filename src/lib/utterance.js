// Pure helpers for voice-activity-detected recording (see vadRecorder.js).

// 16-bit mono PCM WAV, the format Whisper, Gemini and BHASHINI all accept.
export function encodeWav(samples, sampleRate = 16000) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

// 'hold': collect every sentence until the button is released.
// 'tap': done as soon as the first sentence ends (VAD heard a pause).
export class Utterance {
  constructor(mode) {
    this.mode = mode;
    this.segments = [];
  }

  // Returns true when the utterance is complete.
  addSegment(samples) {
    this.segments.push(samples);
    return this.mode === 'tap';
  }

  // Joined audio, or null when no speech was heard (nothing to send).
  audio() {
    if (!this.segments.length) return null;
    const out = new Float32Array(this.segments.reduce((n, s) => n + s.length, 0));
    let at = 0;
    for (const s of this.segments) { out.set(s, at); at += s.length; }
    return out;
  }
}
