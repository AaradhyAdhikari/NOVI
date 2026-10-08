import { describe, it, expect } from 'vitest';
import { cosine, loadSpeakerVerifier } from '../../server/voice/speaker/verifier.js';

// Fake sherpa-onnx SpeakerEmbeddingExtractor: records what it was given.
function fakeExtractor({ ready = true, vector = [1, 2, 3] } = {}) {
  const given = [];
  return {
    given,
    dim: vector.length,
    createStream() {
      return {
        acceptWaveform(obj) { given.push(obj); },
        inputFinished() {},
      };
    },
    isReady: () => ready,
    compute: () => Float32Array.from(vector),
  };
}

describe('speaker verifier', () => {
  it('cosine: same direction 1, opposite-free right angle 0, mismatched lengths 0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2], [1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('is off (no-model) when the model file is missing, without loading anything', async () => {
    let loaded = false;
    const result = await loadSpeakerVerifier({ modelPath: 'nope.onnx', exists: () => false, load: () => { loaded = true; } });
    expect(result).toEqual({ verifier: null, status: 'no-model' });
    expect(loaded).toBe(false);
  });

  it('is off (error) when the model fails to load', async () => {
    const result = await loadSpeakerVerifier({ modelPath: 'm.onnx', exists: () => true, load: () => { throw new Error('bad model'); } });
    expect(result).toEqual({ verifier: null, status: 'error', error: 'bad model' });
  });

  it('embeds 16 kHz audio as floats and returns the voiceprint', async () => {
    const ex = fakeExtractor();
    const { verifier, status } = await loadSpeakerVerifier({ modelPath: '/x/wespeaker.onnx', exists: () => true, load: () => ex });
    expect(status).toBe('ready');
    expect(verifier.dim).toBe(3);
    expect(verifier.model).toBe('wespeaker.onnx');
    expect(Array.from(verifier.embed(Int16Array.from([16384])))).toEqual([1, 2, 3]);
    expect(ex.given[0].sampleRate).toBe(16000);
    expect(Array.from(ex.given[0].samples)).toEqual([0.5]);
    expect(verifier.score([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it('refuses a clip too short to embed', async () => {
    const { verifier } = await loadSpeakerVerifier({ modelPath: 'm.onnx', exists: () => true, load: () => fakeExtractor({ ready: false }) });
    expect(() => verifier.embed(new Int16Array(10))).toThrow(/too short/);
  });
});
