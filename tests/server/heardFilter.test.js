import { describe, it, expect } from 'vitest';
import { judgeHeard } from '../../server/voice/heardFilter.js';

// Live 2026-10-20: after each reply the laptop mic kept listening and acted on noise — "Aung!" ran a sync,
// "Nombardum, Tzadak." and "Thank you." got answers, each answer opened the mic again. Whisper's own
// confidence (avg_logprob) on the saved clips: real commands −0.19…−0.55, noise −0.86…−1.23.
describe('judgeHeard', () => {
  const follow = (text, confidence) => judgeHeard({ text, confidence, followUp: true });

  it('keeps real follow-ups and short answers', () => {
    expect(follow('Yes.', -0.55)).toBe(null);
    expect(follow('What was the next thing I was gonna do on Flexr?', -0.19)).toBe(null);
    for (const w of ['no', 'stop', 'haan', 'nahi', 'cancel', 'okay']) expect(follow(w, -0.4), w).toBe(null);
  });

  it('drops unsure follow-ups (Whisper guessing at noise)', () => {
    expect(follow('you have to sleep you', -1.23)).toMatch(/unsure/);
    expect(follow('Благодарим за ваше.', -0.98)).toMatch(/unsure/);
  });

  it('drops the phrases Whisper makes up from near-silence, and stray single words', () => {
    expect(follow('Thank you.', -0.5)).toMatch(/silence/);
    expect(follow('All right.', -0.5)).toMatch(/silence/);
    expect(follow('you', undefined)).toMatch(/silence/);
    expect(follow('Aung!', -0.5)).toMatch(/one word/);
  });

  it('after "Hey Novi" itself only very unsure words are dropped', () => {
    expect(judgeHeard({ text: 'open youtube', confidence: -0.9, followUp: false })).toBe(null);
    expect(judgeHeard({ text: 'Thank you.', confidence: -0.4, followUp: false })).toBe(null);
    expect(judgeHeard({ text: 'mm hmm aung', confidence: -1.3, followUp: false })).toMatch(/unsure/);
  });

  it('no confidence (another speech service answered): only the word rules', () => {
    expect(follow('Show me the homepage', undefined)).toBe(null);
  });
});
