import { describe, it, expect } from 'vitest';
import { cardViewId } from '../../src/lib/cardWindow.js';

describe('the card window', () => {
  it('takes only a plain card id', () => {
    expect(cardViewId('?cardview=a1-b2_c')).toBe('a1-b2_c');
    expect(cardViewId('?cardview=../x')).toBeNull();
    expect(cardViewId('?card=a1')).toBeNull();
    expect(cardViewId('')).toBeNull();
  });
});
