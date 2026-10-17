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
