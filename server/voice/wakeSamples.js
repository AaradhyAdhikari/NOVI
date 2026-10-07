import fs from 'node:fs';
import path from 'node:path';
import { encodeWav } from '../../src/lib/utterance.js';

// "Hey Novi" practice clips recorded through the laptop wake-word mic (Settings → Voice), each
// with the score the current model gave it. They tune the trigger level now and are the real-voice
// positives for retraining the model (upload data/voice-samples/hey-novi to the Colab notebook).

const MIN = 0.02;
const MAX = 0.9;

// A level ~80% of the user's clips clear, with margin. Never below 0.05: ordinary speech scored
// up to 0.014 on the current model (2026-10-07). Needs 10+ clips.
export function suggestThreshold(scores) {
  if (scores.length < 10) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const p20 = sorted[Math.floor(sorted.length * 0.2)];
  return Math.round(Math.min(0.5, Math.max(0.05, p20 * 0.8)) * 100) / 100;
}

export function createWakeSampleStore({ dir, settingsFile }) {
  const scoresFile = path.join(dir, 'scores.json');
  const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
  let scores = readJson(scoresFile, []);
  let settings = readJson(settingsFile, {});

  return {
    save(audio, score) {
      fs.mkdirSync(dir, { recursive: true });
      const n = scores.length + 1;
      fs.writeFileSync(path.join(dir, `clip-${String(n).padStart(3, '0')}.wav`), encodeWav(Float32Array.from(audio, (s) => s / 32768), 16000));
      scores = [...scores, Math.round(score * 1000) / 1000];
      fs.writeFileSync(scoresFile, JSON.stringify(scores));
      return { count: n, score: scores.at(-1) };
    },
    list: () => ({ count: scores.length, scores: [...scores] }),
    threshold: () => settings.threshold ?? null,
    setThreshold(value) {
      const v = Number(value);
      if (!(v >= MIN && v <= MAX)) throw new Error(`The trigger level must be between ${MIN} and ${MAX}.`);
      settings = { ...settings, threshold: v };
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    },
  };
}
