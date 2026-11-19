import { describe, it, expect } from 'vitest';
import { shownFor } from '../../src/lib/shownCard.js';

describe('what a flick sends from the Novi page', () => {
  it('an open file of a card first, then the flick screen, then the top card', () => {
    expect(shownFor({ file: { card: 'c1', file: 'a.js' }, flickScreen: true, card: 'c2' })).toEqual({ card: 'c1', file: 'a.js' });
    expect(shownFor({ file: { card: 'c1', changes: 'ch1', file: 'a.js' }, flickScreen: false, card: null })).toEqual({ card: 'c1~ch1', file: 'a.js' });
    expect(shownFor({ file: null, flickScreen: true, card: 'c2' })).toBeNull();
    expect(shownFor({ file: null, flickScreen: false, card: 'c2' })).toEqual({ card: 'c2' });
    expect(shownFor({ file: null, flickScreen: false, card: null })).toBeNull();
  });
});
