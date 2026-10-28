import { describe, it, expect } from 'vitest';
import { spokenQuestion, matchAnswer, answerFor } from '../../server/claude/questions.js';

const opts = [{ label: 'Dark' }, { label: 'Light' }, { label: 'Ocean blue' }];

describe("Claude's questions by voice", () => {
  it('speaks the question with numbered options (at most 4)', () => {
    expect(spokenQuestion({ question: 'Which color theme?', options: opts })).toBe('Claude asks: Which color theme? One, Dark. Two, Light. Three, Ocean blue.');
    expect(spokenQuestion({ question: 'Pick one', options: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}` })) })).toBe('Claude asks: Pick one? One, L1. Two, L2. Three, L3. Four, L4.');
  });

  // Live 2026-10-28 (phone): "One Bhashini." — the number and the name together, as Novi reads them.
  it('takes the number and the option name together, when they agree', () => {
    expect(matchAnswer('One Bhashini.', [{ label: 'BHASHINI' }, { label: 'Whisper' }])).toEqual({ kind: 'option', labels: ['BHASHINI'] });
    expect(matchAnswer('two light', opts)).toEqual({ kind: 'option', labels: ['Light'] });
    expect(matchAnswer('option 3 ocean blue', opts)).toEqual({ kind: 'option', labels: ['Ocean blue'] });
    expect(matchAnswer('one light', opts).kind).toBe('own');
  });

  it('matches numbers (en / hi / mr) and option names', () => {
    for (const [t, want] of [['one', 'Dark'], ['the first one', 'Dark'], ['2', 'Light'], ['doosra', 'Light'], ['teesra wala', 'Ocean blue'], ['pehla', 'Dark'], ['last one', 'Ocean blue'], ['dark', 'Dark'], ['blue', 'Ocean blue'], ['Light please', 'Light'], ['Option two.', 'Light'], ['dusra', 'Light']])
      expect(matchAnswer(t, opts), t).toEqual({ kind: 'option', labels: [want] });
  });

  it('anything else is the user\'s own answer; skip words skip', () => {
    expect(matchAnswer('make it purple', opts)).toEqual({ kind: 'own', text: 'make it purple' });
    expect(matchAnswer('skip', opts)).toEqual({ kind: 'skip' });
    expect(matchAnswer('rehne do', opts)).toEqual({ kind: 'skip' });
  });

  it('several answers when Claude allows more than one', () => {
    expect(matchAnswer('one and three', opts, { multiSelect: true })).toEqual({ kind: 'option', labels: ['Dark', 'Ocean blue'] });
    expect(matchAnswer('dark aur light', opts, { multiSelect: true })).toEqual({ kind: 'option', labels: ['Dark', 'Light'] });
    expect(matchAnswer('one and three', opts)).toEqual({ kind: 'own', text: 'one and three' });
  });

  it('the answer text sent back to Claude', () => {
    expect(answerFor({ kind: 'option', labels: ['Dark', 'Light'] })).toBe('Dark, Light');
    expect(answerFor({ kind: 'own', text: 'make it purple' })).toBe('make it purple');
    expect(answerFor({ kind: 'skip' })).toBe('');
  });
});
