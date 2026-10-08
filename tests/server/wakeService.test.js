import { describe, it, expect, vi } from 'vitest';
import { conversationNext, keepRestarting, speakerOptions } from '../../server/voice/wakeword/service.js';

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

describe('speakerOptions (only my voice + interrupt wiring)', () => {
  const quietLogger = { log: () => {}, warn: () => {} };

  it('asks Novi whether it is the owner: yes, no, or off', () => {
    const answers = [true, false, null];
    const novi = { checkVoice: () => ({ ok: answers.shift(), score: 0.5 }) };
    const { checkSpeaker } = speakerOptions({ novi, env: {}, logger: quietLogger });
    expect([checkSpeaker(new Int16Array(1)), checkSpeaker(new Int16Array(1)), checkSpeaker(new Int16Array(1))]).toEqual([true, false, null]);
    expect(speakerOptions({ novi: {}, env: {}, logger: quietLogger }).checkSpeaker(new Int16Array(1))).toBeNull();
  });

  it('takes the interrupt level from NOVI_WAKEWORD_INTERRUPT_THRESHOLD, else leaves it to the listener', () => {
    expect(speakerOptions({ novi: {}, env: { NOVI_WAKEWORD_INTERRUPT_THRESHOLD: '0.8' }, logger: quietLogger }).interruptThreshold).toBe(0.8);
    expect(speakerOptions({ novi: {}, env: {}, logger: quietLogger }).interruptThreshold).toBeNull();
  });

  it('an interrupt stops Novi talking and shows that it is listening', () => {
    const calls = [];
    const novi = { stopSpeaking: () => calls.push('stop'), broadcast: (m) => calls.push(m.type) };
    speakerOptions({ novi, env: {}, logger: quietLogger }).onInterrupt();
    expect(calls).toEqual(['stop', 'wake']);
  });

  it('logs another voice only in debug mode', () => {
    const lines = [];
    const logger = { log: (l) => lines.push(l), warn: () => {} };
    speakerOptions({ novi: {}, env: {}, logger }).onRejected({ score: 0.9 });
    expect(lines).toEqual([]);
    speakerOptions({ novi: {}, env: { NOVI_WAKEWORD_DEBUG: '1' }, logger }).onRejected({ score: 0.9 });
    expect(lines[0]).toMatch(/not the owner/);
  });
});
