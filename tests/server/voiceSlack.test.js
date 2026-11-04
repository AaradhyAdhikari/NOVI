import { describe, it, expect } from 'vitest';
import { cardSlack, voiceSlack } from '../../server/voice/heardFilter.js';

// Live 2026-11-04: a one-word "Approve" scored 0.54 against 0.57 and the card answer was lost.
describe('the voice check while a card waits', () => {
  it('is a little easier for an ordinary card', () => {
    expect(cardSlack([{ tier: 'medium' }])).toBe(0.08);
  });
  it('is unchanged with no card', () => {
    expect(cardSlack([])).toBe(0);
  });
  it('is unchanged for anything needing more than a yes', () => {
    for (const card of [{ tier: 'high' }, { tier: 'medium', pin: true }, { tier: 'medium', kind: 'delete' }]) expect(cardSlack([card]), JSON.stringify(card)).toBe(0);
    expect(cardSlack([{ tier: 'medium' }, { tier: 'high' }])).toBe(0);
  });
});

// Live 2026-11-04: a real clip on the phone scored 0.568 against 0.57; the voice was learned on the laptop mic.
describe('the voice check on a phone', () => {
  const phone = { deviceId: 'p1' };
  it('is a little easier than on the laptop', () => {
    expect(voiceSlack([], phone)).toBe(0.05);
    expect(voiceSlack([], 'local')).toBe(0);
  });
  it('takes the bigger slack, never both', () => {
    expect(voiceSlack([{ tier: 'medium' }], phone)).toBe(0.08);
    expect(voiceSlack([{ tier: 'medium' }], 'local')).toBe(0.08);
  });
  it('keeps the full check while a riskier card waits', () => {
    for (const card of [{ tier: 'high' }, { tier: 'medium', pin: true }, { tier: 'medium', kind: 'delete' }]) expect(voiceSlack([card], phone), JSON.stringify(card)).toBe(0);
  });
});
