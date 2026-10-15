// "Hey Novi" without a trained model: sherpa-onnx keyword spotting (Apache-2.0; the idea comes from
// Dodaios, also Apache-2.0). A small English speech model listens for the phrase spelled in its own
// sub-word pieces (models/kws/keywords.txt), so a new wake phrase is a line of text, not a Colab run.
// Same shape as the old detector: process(16 kHz Int16 audio) → one score per 80 ms (1 = heard).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const CHUNK = 1280; // 80 ms at 16 kHz, the listener's frame
const FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt', 'keywords.txt'];

export const kwsAvailable = (dir) => FILES.every((f) => fs.existsSync(path.join(dir, f)));

export function createKwsDetector({ dir, keywordsFile = path.join(dir, 'keywords.txt'), threshold = 0.15, score = 1.0 }) {
  const { KeywordSpotter } = createRequire(import.meta.url)('sherpa-onnx-node');
  const spotter = new KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') },
      tokens: path.join(dir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile,
    keywordsThreshold: threshold,
    keywordsScore: score,
  });
  const stream = spotter.createStream();
  let pending = new Int16Array(0);

  function runChunk(int16) {
    const samples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768;
    stream.acceptWaveform({ sampleRate: 16000, samples });
    let heard = 0;
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      if (spotter.getResult(stream).keyword) {
        heard = 1;
        spotter.reset(stream); // ready for the next "Hey Novi"
      }
    }
    return heard;
  }

  return {
    engine: 'keyword spotting',
    async process(samples) {
      const all = new Int16Array(pending.length + samples.length);
      all.set(pending, 0);
      all.set(samples, pending.length);
      const scores = [];
      let at = 0;
      for (; at + CHUNK <= all.length; at += CHUNK) scores.push(runChunk(all.subarray(at, at + CHUNK)));
      pending = all.slice(at);
      return scores;
    },
  };
}
