import { describe, it, expect } from 'vitest';
import { encodeWav, Utterance } from '../../src/lib/utterance.js';

const ascii = (bytes, from, len) => String.fromCharCode(...bytes.slice(from, from + len));

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM WAV header and samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 4 * 2);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767); // clamped
  });
});

describe('Utterance', () => {
  it('hold mode keeps every speech segment until release, then joins them', () => {
    const u = new Utterance('hold');
    expect(u.addSegment(new Float32Array([0.1, 0.2]))).toBe(false);
    expect(u.addSegment(new Float32Array([0.3]))).toBe(false);
    expect(Array.from(u.audio())).toEqual([0.1, 0.2, 0.3].map(Math.fround));
  });

  it('tap mode is done after the first finished sentence', () => {
    const u = new Utterance('tap');
    expect(u.addSegment(new Float32Array([0.5]))).toBe(true);
  });

  it('has no audio when nobody spoke, so nothing is sent', () => {
    expect(new Utterance('hold').audio()).toBeNull();
  });
});
