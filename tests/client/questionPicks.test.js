import { describe, it, expect } from 'vitest';
import { togglePick, pickedAnswer, openedCard } from '../../src/lib/approvalText.js';

// User, 2026-11-07: only questions where several options can be picked get a Submit button; on the rest one
// tap sends. The page used to send on the first tap even when several could be picked.
const options = [{ label: 'Light' }, { label: 'Dark' }, { label: 'Auto' }];

describe('picking several options', () => {
  it('a tap adds an option, a second tap takes it off', () => {
    expect(togglePick([], 'Dark')).toEqual(['Dark']);
    expect(togglePick(['Dark'], 'Light')).toEqual(['Dark', 'Light']);
    expect(togglePick(['Dark', 'Light'], 'Dark')).toEqual(['Light']);
  });
  it('the answer lists them in the order shown, like the phone', () => {
    expect(pickedAnswer(options, ['Auto', 'Light'])).toBe('Light, Auto');
  });
  it('nothing picked is no answer', () => {
    expect(pickedAnswer(options, [])).toBe('');
  });
});

// "Read the whole plan" opens Novi at /?card=<id>: that card's detail starts open (live: it sat in a fold).
describe('a card opened by its link', () => {
  it('only that card', () => {
    expect(openedCard('?card=a1', 'a1')).toBe(true);
    expect(openedCard('?card=a1', 'b2')).toBe(false);
    expect(openedCard('', 'a1')).toBe(false);
  });
});
