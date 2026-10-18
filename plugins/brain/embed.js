import fs from 'node:fs';
import path from 'node:path';

// Meaning search, on the laptop only (user, 2026-10-18: "local model"): multilingual-e5-small (English,
// Hindi, Marathi and ~100 more), int8 ONNX ≈ 118 MB, downloaded once into data/brain/models and run
// with the onnxruntime-node Novi already has for the wake word; the tokenizer is @huggingface/tokenizers
// (0.6 MB). Nothing leaves the laptop. Texts become 384 numbers whose closeness = closeness in meaning.
export const MODEL = {
  id: 'Xenova/multilingual-e5-small',
  dir: 'multilingual-e5-small',
  files: { 'tokenizer.json': 'tokenizer.json', 'tokenizer_config.json': 'tokenizer_config.json', 'model.onnx': 'onnx/model_quantized.onnx' },
  dims: 384,
};
const MAX_TOKENS = 256;

async function download(url, to, log) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${path.basename(to)}`);
  const tmp = `${to}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, to);
  log(`[brain] downloaded ${path.basename(to)} (${Math.round(fs.statSync(to).size / 1e6)} MB)`);
}

// embed(texts, 'query' | 'passage') → Float32Array[] (unit length). ready() = loaded; null = not yet.
export function createEmbedder({ dir, base = 'https://huggingface.co', log = () => {}, loadOrt = () => import('onnxruntime-node'), loadTokenizers = () => import('@huggingface/tokenizers') } = {}) {
  let loading = null;
  let session = null;
  let tokenizer = null;
  let broken = null;
  let failedAt = 0;
  const folder = path.join(dir, MODEL.dir);

  async function load() {
    fs.mkdirSync(folder, { recursive: true });
    for (const [name, remote] of Object.entries(MODEL.files)) {
      const to = path.join(folder, name);
      if (!fs.existsSync(to)) await download(`${base}/${MODEL.id}/resolve/main/${remote}`, to, log);
    }
    const { Tokenizer } = await loadTokenizers();
    const read = (n) => JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8'));
    tokenizer = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'));
    const mod = await loadOrt();
    const ort = mod.default || mod;
    session = await ort.InferenceSession.create(path.join(folder, 'model.onnx'));
    return { ort };
  }

  return {
    ready: () => Boolean(session),
    starting: () => Boolean(loading) && !session && !broken,
    broken: () => broken,
    // Starts the download/load once; never throws (a failure turns meaning search off and says why).
    // After a failure (offline, the download cut off) it tries again 30 minutes later.
    start() {
      if (broken && Date.now() - failedAt > 30 * 60_000) { loading = null; broken = null; }
      if (!loading) loading = load().catch((err) => { broken = err.message; failedAt = Date.now(); log(`[brain] meaning search is off for now: ${err.message}`); return null; });
      return loading;
    },
    async embed(texts, kind = 'passage') {
      const loaded = await this.start();
      if (!loaded || !session) return null;
      const { ort } = loaded;
      const enc = texts.map((t) => {
        const ids = tokenizer.encode(`${kind}: ${String(t).slice(0, 4000)}`).ids;
        return ids.length > MAX_TOKENS ? [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]] : ids;
      });
      const len = Math.max(...enc.map((e) => e.length));
      const ids = new BigInt64Array(enc.length * len);
      const mask = new BigInt64Array(enc.length * len);
      enc.forEach((e, b) => e.forEach((id, i) => { ids[b * len + i] = BigInt(id); mask[b * len + i] = 1n; }));
      const feeds = { input_ids: new ort.Tensor('int64', ids, [enc.length, len]), attention_mask: new ort.Tensor('int64', mask, [enc.length, len]) };
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(enc.length * len), [enc.length, len]);
      const out = await session.run(feeds);
      const hidden = out.last_hidden_state || out[session.outputNames[0]];
      const dims = hidden.dims[2];
      // Mean of the real tokens, then unit length (cosine = dot product).
      return enc.map((e, b) => {
        const v = new Float32Array(dims);
        for (let i = 0; i < e.length; i++) for (let d = 0; d < dims; d++) v[d] += hidden.data[(b * len + i) * dims + d];
        let norm = 0;
        for (let d = 0; d < dims; d++) { v[d] /= e.length; norm += v[d] * v[d]; }
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < dims; d++) v[d] /= norm;
        return v;
      });
    },
  };
}

// 384 floats → 384 bytes (+ one scale), so 100,000 passages fit in ~40 MB.
export function quantize(v) {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const scale = max / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { q, scale };
}
