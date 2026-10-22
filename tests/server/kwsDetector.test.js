import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createKwsDetector, kwsAvailable } from '../../server/voice/wakeword/kwsDetector.js';
import { readWavInt16 } from '../../server/voice/wakeword/detector.js';

// "Hey Novi" without training: sherpa-onnx keyword spotting (idea from Dodaios, Apache 2.0).
// Fixtures: synthetic voices saying "Hey Novi" and sound-alikes, 16 kHz mono.
const DIR = path.resolve('models/kws');
const clip = (name) => readWavInt16(fs.readFileSync(path.resolve('tests/fixtures', name)));

async function heard(detector, samples) {
  let best = 0;
  for (let i = 0; i < samples.length; i += 1280) best = Math.max(best, ...(await detector.process(samples.subarray(i, i + 1280))));
  best = Math.max(best, ...(await detector.process(new Int16Array(16000)))); // a second of silence after
  return best;
}

describe('"Hey Novi" by keyword spotting (no trained model needed)', () => {
  it('the model ships with Novi', () => {
    expect(kwsAvailable(DIR)).toBe(true);
  });

  it('hears "Hey Novi" in different voices', async () => {
    for (const f of ['kws-pos-1.wav', 'kws-pos-20.wav']) {
      const detector = createKwsDetector({ dir: DIR });
      expect(await heard(detector, clip(f)), f).toBe(1);
    }
  }, 60_000); // real speech model: ~10 s on the laptop

  it('ignores sound-alikes ("Novak is playing tennis", "hey nobody is here")', async () => {
    for (const f of ['kws-neg-12.wav', 'kws-neg-50.wav']) {
      const detector = createKwsDetector({ dir: DIR });
      expect(await heard(detector, clip(f)), f).toBe(0);
    }
  }, 60_000);

  it('reports one score per 80 ms of audio, like the old detector', async () => {
    const detector = createKwsDetector({ dir: DIR });
    expect(await detector.process(new Int16Array(1280 * 3))).toHaveLength(3);
    expect(await detector.process(new Int16Array(640))).toHaveLength(0);
    expect(await detector.process(new Int16Array(640))).toHaveLength(1);
  }, 60_000);
});

describe('which "Hey Novi" engine starts', async () => {
  const { pickWakeEngine } = await import('../../server/voice/wakeword/service.js');
  const has = (...files) => (f) => files.some((x) => f.endsWith(x));
  it('keyword spotting when its model is there (no training needed), else the trained model, else none', () => {
    expect(pickWakeEngine({ env: {}, exists: has('keywords.txt', 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt') }).engine).toBe('kws');
    expect(pickWakeEngine({ env: {}, exists: has('hey_novi.onnx', 'melspectrogram.onnx', 'embedding_model.onnx') }).engine).toBe('model');
    expect(pickWakeEngine({ env: {}, exists: () => false }).engine).toBeNull();
  });
  it('NOVI_WAKEWORD_ENGINE=model keeps the trained model', () => {
    const all = () => true;
    expect(pickWakeEngine({ env: { NOVI_WAKEWORD_ENGINE: 'model' }, exists: all }).engine).toBe('model');
    expect(pickWakeEngine({ env: {}, exists: all }).engine).toBe('kws');
  });
});
