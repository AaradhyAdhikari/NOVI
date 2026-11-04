import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { createSpeakerWorker } from '../../server/voice/speaker/speakerWorker.js';
import { speakerModelPath, cosine } from '../../server/voice/speaker/verifier.js';

const script = new URL('../fixtures/fake-speaker-thread.mjs', import.meta.url);

describe('the speaker model in its own thread', () => {
  let w;
  afterEach(() => w?.stop());

  it('sends a clip and gets its vector back', async () => {
    w = createSpeakerWorker({ modelPath: 'x', script });
    expect([...await w.embed([1, 5, 6])]).toEqual([3, 2]);
  });
  it('a clip it cannot read is an error, not a hang', async () => {
    w = createSpeakerWorker({ modelPath: 'x', script });
    await expect(w.embed([2])).rejects.toThrow('too short');
  });
  it('gives up after the time limit', async () => {
    w = createSpeakerWorker({ modelPath: 'x', script, timeoutMs: 100 });
    await expect(w.embed([3])).rejects.toThrow('took too long');
  });
  it('a stuck clip does not hold up the next one', async () => {
    w = createSpeakerWorker({ modelPath: 'x', script, timeoutMs: 100 });
    await expect(w.embed([3])).rejects.toThrow('took too long');
    expect([...await w.embed([1])]).toEqual([1, 2]);
  });
  it('a crash fails the clip, and the next clip starts a new thread', async () => {
    w = createSpeakerWorker({ modelPath: 'x', script });
    await expect(w.embed([4])).rejects.toThrow();
    expect([...await w.embed([1])]).toEqual([1, 2]);
  });
  it.skipIf(!fs.existsSync(speakerModelPath()))('runs the real model: the same clip gives the same voice', async () => {
    w = createSpeakerWorker({ modelPath: speakerModelPath(), timeoutMs: 20_000 });
    const clip = Int16Array.from({ length: 32000 }, (_, i) => Math.round(8000 * Math.sin(i / 9) * Math.sin(i / 700)));
    const [a, b] = [await w.embed(clip), await w.embed(clip)];
    expect(a.length).toBeGreaterThan(50);
    expect(cosine(a, b)).toBeGreaterThan(0.99);
  }, 30_000);
});
