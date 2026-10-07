import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

let HandsFree;
beforeAll(async () => {
  globalThis.window = globalThis.window || {};
  ({ HandsFree } = await import('../../src/lib/handsFree.js'));
});

// Fake Chrome SpeechRecognition.
function fakeRecognition({ failStarts = 0 } = {}) {
  const instances = [];
  let failures = failStarts;
  class Rec {
    constructor() { instances.push(this); this.started = false; }
    start() {
      if (failures > 0) { failures -= 1; throw new Error('InvalidStateError'); }
      this.started = true;
      this.onstart?.();
    }
    abort() { this.started = false; this.onend?.(); }
    say(transcript) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal: true })] }); }
    fail(error) { this.onerror?.({ error }); this.started = false; this.onend?.(); }
    end() { this.started = false; this.onend?.(); }
  }
  return { Rec, instances, live: () => instances.filter((r) => r.started) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('hands-free "Hey Novi"', () => {
  it('starts listening and passes commands on', () => {
    const { Rec, instances } = fakeRecognition();
    const commands = [];
    const hf = new HandsFree({ Recognition: Rec, onCommand: (t) => commands.push(t) });
    hf.start();
    expect(instances).toHaveLength(1);
    instances[0].say('Hey Novi, what time is it');
    expect(commands).toEqual(['what time is it']);
    hf.stop();
  });

  it('restarts when Chrome ends recognition', () => {
    const { Rec, instances, live } = fakeRecognition();
    const hf = new HandsFree({ Recognition: Rec, onCommand: () => {} });
    hf.start();
    instances[0].end();
    vi.advanceTimersByTime(500);
    expect(live()).toHaveLength(1);
    expect(instances).toHaveLength(2);
    hf.stop();
  });

  it('keeps retrying when starting the recognizer throws (watchdog)', () => {
    const { Rec, live } = fakeRecognition({ failStarts: 2 });
    const hf = new HandsFree({ Recognition: Rec, onCommand: () => {} });
    hf.start();
    expect(live()).toHaveLength(0);
    vi.advanceTimersByTime(12_000);
    expect(live()).toHaveLength(1);
    hf.stop();
  });

  it('backs off after a network error instead of looping', () => {
    const { Rec, instances, live } = fakeRecognition();
    const states = [];
    const hf = new HandsFree({ Recognition: Rec, onCommand: () => {}, onState: (s) => states.push(s) });
    hf.start();
    instances[0].fail('network');
    vi.advanceTimersByTime(500);
    expect(instances).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(live()).toHaveLength(1);
    expect(states.some((s) => s.lastError === 'network')).toBe(true);
    hf.stop();
  });

  it('stops and explains when the microphone is blocked', () => {
    const { Rec, instances } = fakeRecognition();
    const states = [];
    const hf = new HandsFree({ Recognition: Rec, onCommand: () => {}, onState: (s) => states.push(s) });
    hf.start();
    instances[0].fail('not-allowed');
    vi.advanceTimersByTime(20_000);
    expect(instances).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ enabled: false, error: expect.stringMatching(/Microphone blocked/) });
  });

  it('does nothing after stop()', () => {
    const { Rec, instances } = fakeRecognition();
    const hf = new HandsFree({ Recognition: Rec, onCommand: () => {} });
    hf.start();
    hf.stop();
    vi.advanceTimersByTime(20_000);
    expect(instances).toHaveLength(1);
  });
});
