import { describe, it, expect } from 'vitest';
import { createWakeListener, normalizeVolume } from '../../server/voice/wakeword/listener.js';

const FRAME = 1280; // 80 ms
const loud = () => new Int16Array(FRAME).fill(3000);
const quiet = () => new Int16Array(FRAME);

// Fake mic: plays the given frames, then stops the listener.
function fakeRecorder(frames, listenerRef) {
  let i = 0;
  return {
    start() {},
    stop() {},
    async read() {
      if (i >= frames.length) { listenerRef.current.stop(); return quiet(); }
      return frames[i++].audio;
    },
    frames,
  };
}
// Fake detector: the score attached to each frame.
function fakeDetector(frames) {
  let i = 0;
  return { async process() { return [frames[i++]?.score ?? 0]; } };
}
const f = (audio, score = 0) => ({ audio, score });
const repeat = (n, make) => Array.from({ length: n }, make);

async function run(frames) {
  const ref = {};
  const events = [];
  const listener = createWakeListener({
    recorder: fakeRecorder(frames, ref),
    detector: fakeDetector(frames),
    onWake: (score) => events.push({ wake: score }),
    onCommand: (audio) => events.push({ command: audio.length }),
    onNoCommand: () => events.push({ noCommand: true }),
  });
  ref.current = listener;
  await listener.start();
  return events;
}

describe('always-on wake listener', () => {
  it('after the wake word, records the command until a pause, then hands it over', async () => {
    const frames = [
      ...repeat(5, () => f(quiet())),
      f(loud(), 0.9), // "Hey Novi"
      ...repeat(10, () => f(loud())), // "what's the weather"
      ...repeat(15, () => f(quiet())), // pause -> end of command
      ...repeat(3, () => f(quiet())),
    ];
    const events = await run(frames);
    expect(events[0]).toEqual({ wake: 0.9 });
    expect(events[1].command).toBeGreaterThanOrEqual(10 * FRAME);
    expect(events).toHaveLength(2);
  });

  it('ignores scores under the threshold', async () => {
    const events = await run([...repeat(5, () => f(loud(), 0.3)), ...repeat(5, () => f(quiet()))]);
    expect(events).toEqual([]);
  });

  it('gives up when nobody speaks after the wake word', async () => {
    const events = await run([f(loud(), 0.95), ...repeat(60, () => f(quiet()))]);
    expect(events).toEqual([{ wake: 0.95 }, { noCommand: true }]);
  });

  it('does not wake twice for one long "Hey Novi"', async () => {
    const frames = [
      f(loud(), 0.9), f(loud(), 0.95), f(loud(), 0.9), // the same wake word over several frames
      ...repeat(5, () => f(loud())),
      ...repeat(15, () => f(quiet())),
    ];
    const events = await run(frames);
    expect(events.filter((e) => e.wake)).toHaveLength(1);
  });

  it('hears soft speech on a quiet microphone (threshold follows the room noise)', async () => {
    const level = (v) => () => new Int16Array(FRAME).fill(v);
    const frames = [
      ...repeat(30, () => f(level(20)())), // quiet room on a low-gain laptop mic
      f(level(300)(), 0.9),
      ...repeat(8, () => f(level(300)())), // soft speech, far under the old fixed bar of 800
      ...repeat(15, () => f(level(20)())),
    ];
    const events = await run(frames);
    expect(events[1]?.command).toBeGreaterThanOrEqual(8 * FRAME);
  });

  it('does not mistake a steady hum for speech', async () => {
    const hum = () => new Int16Array(FRAME).fill(500);
    const events = await run([...repeat(30, () => f(hum())), f(hum(), 0.9), ...repeat(60, () => f(hum()))]);
    expect(events).toEqual([{ wake: 0.9 }, { noCommand: true }]);
  });

  it('stops recording a command that never pauses (8 s cap)', async () => {
    const events = await run([f(loud(), 0.9), ...repeat(120, () => f(loud()))]);
    expect(events[1].command).toBeLessThanOrEqual(Math.ceil(8000 / 80) * FRAME);
  });
});

describe('picking the wake-word microphone', async () => {
  const { pickMicIndex } = await import('../../server/voice/wakeword/service.js');
  const devices = ['Microphone Array (Realtek(R) Audio)', 'Microphone (AB13X USB Audio)'];
  it('uses the Windows default when nothing is set', () => expect(pickMicIndex(devices, undefined)).toBe(-1));
  it('accepts an index', () => expect(pickMicIndex(devices, '1')).toBe(1));
  it('accepts part of the name, any case', () => expect(pickMicIndex(devices, 'realtek')).toBe(0));
  it('falls back to the default for an unknown name', () => expect(pickMicIndex(devices, 'blue yeti')).toBe(-1));
});

describe('normalizeVolume', () => {
  it('boosts a quiet recording so its loudest point is near full scale', () => {
    const out = normalizeVolume(Int16Array.from([0, 500, -1000, 250]));
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(25000);
    expect(out[2]).toBeLessThan(0);
  });
  it('never boosts more than 50x (so near-silence stays quiet) and never clips loud audio', () => {
    expect(Math.max(...normalizeVolume(Int16Array.from([10, -10])))).toBe(500);
    expect(Array.from(normalizeVolume(Int16Array.from([32000, -32000])))).toEqual([32000, -32000]);
  });
});
