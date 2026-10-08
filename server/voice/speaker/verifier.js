// Voiceprints for "only my voice": a free offline speaker model (WeSpeaker ResNet34 via
// sherpa-onnx, Apache-2.0) turns ~1–2 s of 16 kHz audio into a vector; two clips of the same
// person point the same way (cosine close to 1). No model file → the check is simply off.
import fs from 'node:fs';
import path from 'node:path';

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function loadSherpa(modelPath) {
  const mod = await import('sherpa-onnx-node');
  const { SpeakerEmbeddingExtractor } = mod.default ?? mod;
  return new SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, provider: 'cpu', debug: 0 });
}

export async function loadSpeakerVerifier({ modelPath, load = loadSherpa, exists = fs.existsSync }) {
  if (!exists(modelPath)) return { verifier: null, status: 'no-model' };
  let extractor;
  try {
    extractor = await load(modelPath);
  } catch (err) {
    return { verifier: null, status: 'error', error: err.message };
  }
  const verifier = {
    dim: extractor.dim,
    model: path.basename(modelPath),
    embed(audio) {
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: Float32Array.from(audio, (s) => s / 32768) });
      stream.inputFinished();
      if (!extractor.isReady(stream)) throw new Error('The clip is too short to recognise a voice.');
      return extractor.compute(stream);
    },
    score: cosine,
  };
  return { verifier, status: 'ready' };
}
