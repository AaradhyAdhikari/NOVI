import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
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
  const fakeThreads = () => {
    const made = [];
    class Thread extends EventEmitter {
      constructor() { super(); this.sent = []; this.ended = 0; made.push(this); }
      unref() {}
      postMessage(m) { this.sent.push(m); }
      terminate() { this.ended += 1; return Promise.resolve(); }
    }
    return { made, Thread };
  };
  it('a late timeout quits only its own stuck thread, never the new healthy one', async () => {
    const { made, Thread } = fakeThreads();
    const s = createSpeakerWorker({ modelPath: 'x', script, timeoutMs: 40, Thread });
    const a = s.embed([1]);
    await new Promise((r) => { setTimeout(r, 20); });
    const b = s.embed([2]);
    await expect(a).rejects.toThrow('took too long');
    const c = s.embed([3]);
    c.catch(() => {});
    await expect(b).rejects.toThrow('took too long');
    expect(made).toHaveLength(2);
    expect(made[1].sent.some((m) => m.quit)).toBe(false);
  });
  it('two stuck threads are the limit: after that the voice just goes unchecked, with no new model', async () => {
    const { made, Thread } = fakeThreads();
    const s = createSpeakerWorker({ modelPath: 'x', script, timeoutMs: 10, Thread });
    await expect(s.embed([1])).rejects.toThrow('took too long');
    await expect(s.embed([2])).rejects.toThrow('took too long');
    await expect(s.embed([3])).rejects.toThrow('stuck');
    expect(made).toHaveLength(2);
    made[0].emit('exit');
    await expect(s.embed([4])).rejects.toThrow('took too long');
    expect(made).toHaveLength(3);
  });
  it('a stuck thread is never force-ended: that crashes Novi. It is asked to quit after its clip', async () => {
    const { made, Thread } = fakeThreads();
    const stuck = createSpeakerWorker({ modelPath: 'x', script, timeoutMs: 20, Thread });
    await expect(stuck.embed([3])).rejects.toThrow('took too long');
    expect(made[0].ended).toBe(0);
    expect(made[0].sent.at(-1)).toEqual({ quit: true });
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
