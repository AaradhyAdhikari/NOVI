import { describe, it, expect } from 'vitest';
import { createWorkerEmbedder } from '../../plugins/brain/embedWorker.js';

// Live 2026-10-22 (profile): the meaning model ran on Novi's main thread — onnxruntime's "async" run()
// blocks it — about 39 s of every 110 s. It now runs in a worker thread with the same shape.
const script = new URL('../fixtures/fake-embed-thread.mjs', import.meta.url);

describe('meaning model in a worker thread', () => {
  it('starts, says ready, and turns texts into vectors', async () => {
    const logs = [];
    const e = createWorkerEmbedder({ dir: 'x', script, log: (m) => logs.push(m) });
    expect(e.ready()).toBe(false);
    expect(await e.start()).toBe(true);
    expect(e.ready()).toBe(true);
    const [a, b] = await e.embed(['hi', 'hello'], 'passage');
    expect(a).toBeInstanceOf(Float32Array);
    expect([...a]).toEqual([2, 1, 0]);
    expect(b[0]).toBe(5);
    expect(logs).toContain('[brain] fake model loaded');
    e.close();
  });

  it('a model that will not load: off, with the reason, and embed gives null', async () => {
    const e = createWorkerEmbedder({ dir: 'broken', script });
    expect(await e.start()).toBe(null);
    expect(e.broken()).toMatch(/503/);
    expect(await e.embed(['x'])).toBe(null);
    e.close();
  });
});
