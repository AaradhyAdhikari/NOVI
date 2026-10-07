import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suggestThreshold, createWakeSampleStore } from '../../server/voice/wakeSamples.js';

describe('suggestThreshold', () => {
  it('needs at least 10 clips', () => {
    expect(suggestThreshold([0.4, 0.5, 0.6])).toBeNull();
  });
  it('picks a level most of your clips clear, never below 0.05 or above 0.5', () => {
    const scores = [0.02, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6];
    expect(suggestThreshold(scores)).toBe(0.16); // 2nd-lowest of 10 (0.2) × 0.8
    expect(suggestThreshold(Array(10).fill(0.01))).toBe(0.05); // ordinary speech scored up to 0.014
    expect(suggestThreshold(Array(10).fill(0.95))).toBe(0.5);
  });
});

describe('wake sample store', () => {
  const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-wake-'));
    return { dir, store: createWakeSampleStore({ dir: path.join(dir, 'hey-novi'), settingsFile: path.join(dir, 'wakeword.json') }) };
  };

  it('saves numbered 16 kHz WAV clips with their scores', () => {
    const { dir, store } = make();
    store.save(new Int16Array(16000), 0.31);
    store.save(new Int16Array(16000), 0.12);
    const files = fs.readdirSync(path.join(dir, 'hey-novi')).sort();
    expect(files).toEqual(['clip-001.wav', 'clip-002.wav', 'scores.json']);
    expect(fs.readFileSync(path.join(dir, 'hey-novi', 'clip-001.wav')).subarray(0, 4).toString()).toBe('RIFF');
    expect(store.list()).toEqual({ count: 2, scores: [0.31, 0.12] });
  });

  it('remembers a chosen threshold, within sane limits', () => {
    const { dir, store } = make();
    expect(store.threshold()).toBeNull();
    store.setThreshold(0.16);
    expect(createWakeSampleStore({ dir: path.join(dir, 'hey-novi'), settingsFile: path.join(dir, 'wakeword.json') }).threshold()).toBe(0.16);
    expect(() => store.setThreshold(0.001)).toThrow();
    expect(() => store.setThreshold(2)).toThrow();
  });
});
