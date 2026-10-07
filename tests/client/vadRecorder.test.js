import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake Silero VAD: records how it is created and used.
const created = [];
vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn(async (options) => {
      const vad = {
        options,
        calls: [],
        start: vi.fn(async () => { vad.calls.push('start'); }),
        pause: vi.fn(async () => { vad.calls.push('pause'); }),
        destroy: vi.fn(async () => { vad.calls.push('destroy'); }),
      };
      created.push(vad);
      return vad;
    }),
  },
}));

const { startVadRecording, warmVad } = await import('../../src/lib/vadRecorder.js');

describe('vadRecorder', () => {
  beforeEach(() => { created.length = 0; });

  it('loads the speech detector once without opening the mic, then reuses it', async () => {
    await warmVad();
    expect(created).toHaveLength(1);
    expect(created[0].options.startOnLoad).toBe(false);
    expect(created[0].options.redemptionMs).toBe(700); // 0.7 s of quiet ends a sentence
    expect(created[0].calls).toEqual([]);

    const first = await startVadRecording();
    created[0].options.onSpeechStart();
    created[0].options.onSpeechEnd(new Float32Array(16000));
    expect(await first.finish()).toBeInstanceOf(Blob);
    const second = await startVadRecording();
    await second.finish();

    expect(created).toHaveLength(1);
    expect(created[0].calls).toEqual(['start', 'pause', 'start', 'pause']); // pause = mic off; never destroyed
  });

});
