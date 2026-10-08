import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeWav } from '../../src/lib/utterance.js';
import { cosine } from '../../server/voice/speaker/verifier.js';
import { enrollVoice, readClips, createVoiceprintStore } from '../../server/voice/speaker/enroll.js';

// Fake verifier: the clip's first sample picks its voiceprint (owner clips differ a little).
const VECTORS = { 1: [1, 0.1, 0], 2: [1, 0, 0.1], 3: [0.9, 0.1, 0.1], 4: [1, 0.05, 0.05], 5: [1, 0.12, 0], 6: [0.95, 0, 0.12] };
const fakeVerifier = (failing = []) => ({
  dim: 3,
  model: 'fake.onnx',
  embed(audio) {
    if (failing.includes(audio[0])) throw new Error('too short');
    return Float32Array.from(VECTORS[audio[0]]);
  },
  score: cosine,
});
const clip = (n) => Int16Array.from([n, 0, 0]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-voice-'));

describe('learning the owner\'s voice', () => {
  it('averages the clips and suggests a strictness below the owner\'s worst clip', () => {
    const result = enrollVoice({ verifier: fakeVerifier(), clips: [1, 2, 3, 4, 5, 6].map(clip) });
    expect(result.clipCount).toBe(6);
    expect(result.voiceprint).toHaveLength(3);
    const [min, max] = result.selfScores;
    expect(min).toBeGreaterThan(0.9);
    expect(max).toBeLessThanOrEqual(1);
    expect(result.suggested).toBe(Math.round(Math.max(0.25, min - 0.1) * 100) / 100);
    expect(result.suggested).toBeLessThanOrEqual(min - 0.1 + 0.005);
  });

  it('needs at least 5 usable clips', () => {
    expect(() => enrollVoice({ verifier: fakeVerifier(), clips: [1, 2, 3, 4].map(clip) })).toThrow("Record at least 5 'Hey Novi' clips first.");
    expect(() => enrollVoice({ verifier: fakeVerifier([5, 6]), clips: [1, 2, 3, 4, 5, 6].map(clip) })).toThrow("Record at least 5 'Hey Novi' clips first.");
  });

  it('reads the practice clips and skips broken files', () => {
    const dir = tmp();
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `clip-00${i}.wav`), encodeWav(new Float32Array(1600).fill(0.1), 16000));
    fs.writeFileSync(path.join(dir, 'bad.wav'), 'not audio');
    fs.writeFileSync(path.join(dir, 'scores.json'), '[]');
    const clips = readClips(dir);
    expect(clips).toHaveLength(5);
    expect(clips[0]).toBeInstanceOf(Int16Array);
    expect(readClips(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('voiceprint store', () => {
  it('saves the voiceprint, keeps the numbers private, and checks strictness', () => {
    const file = path.join(tmp(), 'voiceprint.json');
    const store = createVoiceprintStore({ file });
    expect(store.get()).toBeNull();
    expect(store.summary().learned).toBe(false);
    const enrollment = enrollVoice({ verifier: fakeVerifier(), clips: [1, 2, 3, 4, 5, 6].map(clip) });
    const summary = store.save(enrollment, { model: 'fake.onnx' });
    expect(summary).toMatchObject({ learned: true, enabled: true, clipCount: 6, strictness: enrollment.suggested, model: 'fake.onnx' });
    expect(summary).not.toHaveProperty('voiceprint');
    expect(store.get().voiceprint).toHaveLength(3);
    expect(() => store.update({ strictness: 0.95 })).toThrow('Strictness must be between 0.1 and 0.9.');
    expect(store.update({ enabled: false }).enabled).toBe(false);
    expect(store.update({ strictness: 0.5 }).strictness).toBe(0.5);
    const again = createVoiceprintStore({ file });
    expect(again.summary()).toMatchObject({ learned: true, enabled: false, strictness: 0.5 });
  });
});
