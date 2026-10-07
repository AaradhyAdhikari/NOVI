// openWakeWord in Node: same streaming pipeline as the Python library
// (audio -> melspectrogram -> speech embedding -> wake-word model), run with onnxruntime-node.
// Input: 16 kHz mono 16-bit audio. Output: one score (0..1) per 80 ms chunk.
import ort from 'onnxruntime-node';

const CHUNK = 1280; // 80 ms at 16 kHz
const MEL_CONTEXT = 160 * 3; // extra samples the melspectrogram needs before each chunk
const MEL_WINDOW = 76; // mel frames per embedding
const MEL_BINS = 32;
const MAX_MEL_FRAMES = 970;

export async function createWakeWordDetector({ melspectrogramPath, embeddingPath, modelPath }) {
  const opts = { executionProviders: ['cpu'], intraOpNumThreads: 1 };
  const [mel, emb, model] = await Promise.all([melspectrogramPath, embeddingPath, modelPath].map((p) => ort.InferenceSession.create(p, opts)));
  const featureCount = model.inputMetadata?.[0]?.shape?.[1] || 16;

  let pending = new Int16Array(0);
  let tail = new Int16Array(MEL_CONTEXT);
  const melFrames = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
  const features = [];

  async function runChunk(chunk) {
    const input = new Float32Array(MEL_CONTEXT + CHUNK);
    input.set(tail, 0);
    input.set(chunk, MEL_CONTEXT);
    tail = chunk.slice(CHUNK - MEL_CONTEXT);

    const melOut = (await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', input, [1, input.length]) }))[mel.outputNames[0]];
    const spec = melOut.data;
    for (let f = 0; f < spec.length / MEL_BINS; f++) {
      const frame = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) frame[b] = spec[f * MEL_BINS + b] / 10 + 2;
      melFrames.push(frame);
    }
    if (melFrames.length > MAX_MEL_FRAMES) melFrames.splice(0, melFrames.length - MAX_MEL_FRAMES);

    const window = new Float32Array(MEL_WINDOW * MEL_BINS);
    melFrames.slice(-MEL_WINDOW).forEach((frame, i) => window.set(frame, i * MEL_BINS));
    const embOut = (await emb.run({ [emb.inputNames[0]]: new ort.Tensor('float32', window, [1, MEL_WINDOW, MEL_BINS, 1]) }))[emb.outputNames[0]];
    features.push(Float32Array.from(embOut.data));
    if (features.length > featureCount) features.shift();
    if (features.length < featureCount) return 0; // warming up (first ~1.3 s)

    const x = new Float32Array(featureCount * features[0].length);
    features.forEach((f, i) => x.set(f, i * f.length));
    const out = (await model.run({ [model.inputNames[0]]: new ort.Tensor('float32', x, [1, featureCount, features[0].length]) }))[model.outputNames[0]];
    return out.data[0];
  }

  return {
    // Accepts any amount of audio; returns a score for each complete 80 ms chunk.
    async process(samples) {
      const all = new Int16Array(pending.length + samples.length);
      all.set(pending, 0);
      all.set(samples, pending.length);
      const scores = [];
      let at = 0;
      for (; at + CHUNK <= all.length; at += CHUNK) scores.push(await runChunk(all.subarray(at, at + CHUNK)));
      pending = all.slice(at);
      return scores;
    },
  };
}

// 16 kHz mono 16-bit PCM WAV -> Int16Array.
export function readWavInt16(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let fmt = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) throw new Error('Need 16 kHz mono 16-bit PCM audio');
      const data = buf.subarray(at + 8, at + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('WAV has no audio data');
}
