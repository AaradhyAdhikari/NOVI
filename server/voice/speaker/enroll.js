// "Learn my voice": the owner's voiceprint = the average of their "Hey Novi" practice clips
// (data/voice-samples/hey-novi). Saved in data/voiceprint.json; the numbers never leave the server.
import fs from 'node:fs';
import path from 'node:path';
import { cosine } from './verifier.js';
import { readWavInt16 } from '../wakeword/detector.js';

const MIN_CLIPS = 5;
const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

function normalize(v) {
  const len = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
  return v.map((x) => x / len);
}

function mean(vectors) {
  const sum = new Array(vectors[0].length).fill(0);
  for (const v of vectors) v.forEach((x, i) => { sum[i] += x; });
  return normalize(sum.map((x) => x / vectors.length));
}

export function readClips(dir) {
  if (!fs.existsSync(dir)) return [];
  const clips = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort()) {
    try {
      clips.push(readWavInt16(fs.readFileSync(path.join(dir, name))));
    } catch {
      // Not a 16 kHz mono clip: leave it out.
    }
  }
  return clips;
}

export function enrollVoice({ verifier, clips }) {
  const prints = [];
  for (const audio of clips) {
    try {
      prints.push(normalize(Array.from(verifier.embed(audio))));
    } catch {
      // Too short or unreadable: leave it out.
    }
  }
  if (prints.length < MIN_CLIPS) throw new Error("Record at least 5 'Hey Novi' clips first.");
  // Each clip against the average of the others: how well the owner matches themselves.
  const self = prints.map((p, i) => cosine(p, mean(prints.filter((_, j) => j !== i))));
  const min = Math.min(...self);
  return {
    voiceprint: mean(prints).map((x) => round(x, 6)),
    clipCount: prints.length,
    selfScores: [round(min, 3), round(Math.max(...self), 3)],
    suggested: round(Math.max(0.25, min - 0.1), 2),
  };
}

export function createVoiceprintStore({ file }) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not learned yet */ }
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  };
  const summary = () => (saved
    ? { learned: true, enabled: saved.enabled, clipCount: saved.clipCount, selfScores: saved.selfScores, strictness: saved.strictness, model: saved.model }
    : { learned: false, enabled: false, clipCount: 0, selfScores: null, strictness: null, model: null });

  return {
    get: () => saved,
    summary,
    save({ voiceprint, clipCount, selfScores, suggested }, { model }) {
      saved = { voiceprint, clipCount, selfScores, strictness: suggested, enabled: true, model, createdAt: new Date().toISOString() };
      write();
      return summary();
    },
    update({ enabled, strictness } = {}) {
      if (!saved) throw new Error('Learn your voice first.');
      if (strictness !== undefined) {
        const v = Number(strictness);
        if (!(v >= 0.1 && v <= 0.9)) throw new Error('Strictness must be between 0.1 and 0.9.');
        saved.strictness = v;
      }
      if (enabled !== undefined) saved.enabled = Boolean(enabled);
      write();
      return summary();
    },
  };
}
