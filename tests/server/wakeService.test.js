import { describe, it, expect, vi } from 'vitest';
import { conversationNext, keepRestarting } from '../../server/voice/wakeword/service.js';

describe('conversationNext', () => {
  it('keeps listening after a reply, deaf for about as long as Novi speaks', () => {
    const next = conversationNext({ text: "what's the weather", reply: 'It is 28 degrees and sunny in Pune.' });
    expect(next.waitMs).toBe(8000);
    expect(next.deafMs).toBeGreaterThan(2000);
    expect(next.deafMs).toBeLessThan(6000);
  });
  it('a longer reply means a longer deaf period', () => {
    const short = conversationNext({ text: 'time', reply: 'It is 9 pm.' });
    const long = conversationNext({ text: 'news', reply: 'Here is a longer answer that takes Novi a good while to say out loud. And a second sentence too.' });
    expect(long.deafMs).toBeGreaterThan(short.deafMs);
  });
  it('ends the conversation when you say stop, bye, thanks or that is all', () => {
    for (const text of ['stop', 'Bye', 'thank you', 'Thanks Novi', "that's all", 'nothing']) expect(conversationNext({ text, reply: 'Okay.' })).toBeNull();
    expect(conversationNext({ text: '', reply: '' })).toBeNull();
  });
});

describe('keepRestarting', () => {
  it('restarts the mic after it fails, waiting a little longer each time, and never gives up', async () => {
    vi.useFakeTimers();
    const starts = [];
    const runner = keepRestarting({ start: async ({ onError }) => { starts.push(onError); }, delays: [1000, 5000], logger: { warn() {}, log() {} } });
    await runner.begin();
    expect(starts).toHaveLength(1);
    starts[0](new Error('PvRecorder failed to read audio data frame.'));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(2);
    starts[1](new Error('again'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts).toHaveLength(3);
    starts[2](new Error('again'));
    await vi.advanceTimersByTimeAsync(5000); // keeps the last delay
    expect(starts).toHaveLength(4);
    runner.stop();
    starts[3](new Error('after stop'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(starts).toHaveLength(4);
    vi.useRealTimers();
  });
});
