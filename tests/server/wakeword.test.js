import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createWakeWordDetector, readWavInt16 } from '../../server/voice/wakeword/detector.js';

const MODELS = path.resolve('models/wakeword');
const haveModels = ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'].every((f) => fs.existsSync(path.join(MODELS, f)));
const fixture = (name) => readWavInt16(fs.readFileSync(path.resolve('tests/fixtures/wake', name)));

// Feed audio in uneven chunks (like a real mic) with a second of silence around it.
async function maxScore(detector, samples) {
  const silence = new Int16Array(16000);
  const all = new Int16Array(silence.length * 2 + samples.length);
  all.set(silence, 0);
  all.set(samples, silence.length);
  let best = 0;
  for (let i = 0; i < all.length; i += 1000) {
    for (const score of await detector.process(all.subarray(i, i + 1000))) best = Math.max(best, score);
  }
  return best;
}

describe('readWavInt16', () => {
  it('reads 16-bit mono PCM samples from a WAV file', () => {
    const samples = fixture('hey-jarvis.wav');
    expect(samples).toBeInstanceOf(Int16Array);
    expect(samples.length).toBeGreaterThan(16000); // over a second at 16 kHz
  });

  it('rejects audio that is not 16 kHz mono 16-bit', () => {
    const wav = Buffer.from(fs.readFileSync(path.resolve('tests/fixtures/wake/hey-jarvis.wav')));
    wav.writeUInt32LE(44100, 24);
    expect(() => readWavInt16(wav)).toThrow(/16 kHz/);
  });
});

describe.skipIf(!haveModels)('openWakeWord detector (real models)', () => {
  const make = () => createWakeWordDetector({
    melspectrogramPath: path.join(MODELS, 'melspectrogram.onnx'),
    embeddingPath: path.join(MODELS, 'embedding_model.onnx'),
    modelPath: path.join(MODELS, 'hey_jarvis_v0.1.onnx'),
  });

  it('scores the wake word high', async () => {
    expect(await maxScore(await make(), fixture('hey-jarvis.wav'))).toBeGreaterThan(0.5);
  }, 60_000);

  it('scores ordinary speech low', async () => {
    expect(await maxScore(await make(), fixture('no-wake.wav'))).toBeLessThan(0.5);
  }, 60_000);

  it('gives one score per 80 ms of audio', async () => {
    const d = await make();
    expect(await d.process(new Int16Array(1280 * 3))).toHaveLength(3);
    expect(await d.process(new Int16Array(600))).toHaveLength(0);
    expect(await d.process(new Int16Array(680))).toHaveLength(1);
  }, 60_000);
});
