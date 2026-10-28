import { describe, it, expect } from 'vitest';
import { foldDetail } from '../../src/lib/approvalText.js';

describe('approval card detail', () => {
  it('short details show as they are; long or multi-line ones are folded away', () => {
    expect(foldDetail('Install the test runner')).toBe(false);
    expect(foldDetail('')).toBe(false);
    expect(foldDetail('npm i\nnpm test')).toBe(true);
    expect(foldDetail('x'.repeat(121))).toBe(true);
  });
});

// User's plan (2026-10-28): after a card is answered, a short status shows for a moment.
describe('resolvedText', async () => {
  const { resolvedText } = await import('../../src/lib/approvalText.js');
  it('says what happened to the card', () => {
    expect(resolvedText({ allow: true })).toBe('Approved');
    expect(resolvedText({ allow: false })).toBe('Denied');
    expect(resolvedText({ allow: true, noted: true })).toBe('Approved, with your note');
    expect(resolvedText({ allow: true, choice: 'claude' })).toBe('Option sent');
    expect(resolvedText({ allow: true, answered: true })).toBe('Answer sent to Claude');
    expect(resolvedText({ allow: false, changed: true })).toBe('Change sent');
    expect(resolvedText({ allow: false, by: 'timeout' })).toBe('Timed out');
  });
});
