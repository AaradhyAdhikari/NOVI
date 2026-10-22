import { describe, it, expect } from 'vitest';
import { createWorkerRecorder } from '../../server/voice/wakeword/micWorker.js';

// Live 2026-10-22: Novi froze for 97 s. PvRecorder's "async" read() is a blocking native call on Novi's
// one thread, and when the mic stops sending audio it waits — and so does everything else. The mic is
// now read in a worker thread; a mic that goes quiet makes read() fail (the listener restarts the mic).
const fake = new URL('../fixtures/fake-mic-thread.mjs', import.meta.url);

describe('mic in a worker thread', () => {
  it('frames come through in order, with the device name', async () => {
    const r = createWorkerRecorder({ frameLength: 4, deviceIndex: -1, workerUrl: fake });
    r.start();
    const a = await r.read();
    const b = await r.read();
    expect(a).toBeInstanceOf(Int16Array);
    expect(a.length).toBe(4);
    expect(b[0]).toBe(a[0] + 1);
    expect(r.getSelectedDevice()).toBe('Fake mic');
    r.release();
  });

  it('a mic that sends nothing: read fails after the stall time instead of hanging', async () => {
    const r = createWorkerRecorder({ frameLength: 4, deviceIndex: -1, workerUrl: fake, workerData: { mode: 'stall' }, stallMs: 150 });
    r.start();
    const started = Date.now();
    await expect(r.read()).rejects.toThrow(/mic sent nothing/);
    expect(Date.now() - started).toBeLessThan(2000);
    r.release();
  });

  it('a slow reader never piles up more than a few seconds of audio', async () => {
    const r = createWorkerRecorder({ frameLength: 4, deviceIndex: -1, workerUrl: fake, maxQueue: 5 });
    r.start();
    await new Promise((res) => setTimeout(res, 300)); // more than 5 frames arrive
    const first = await r.read();
    expect(first[0]).toBeGreaterThan(1); // the oldest were dropped
    r.release();
  });
});
