import { describe, it, expect } from 'vitest';
import { cardSlack } from '../../server/voice/heardFilter.js';

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
