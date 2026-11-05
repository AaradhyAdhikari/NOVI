import { describe, it, expect } from 'vitest';
import { wantsMemory } from '../../src/lib/memoryLink.js';

describe('the link to the memory graph', () => {
  it('?memory opens it, anything else does not', () => {
    expect(wantsMemory('?memory')).toBe(true);
    expect(wantsMemory('?card=1&memory=1')).toBe(true);
    expect(wantsMemory('?card=1')).toBe(false);
    expect(wantsMemory('')).toBe(false);
  });
});
