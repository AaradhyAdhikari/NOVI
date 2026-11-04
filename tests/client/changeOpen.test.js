import { describe, it, expect } from 'vitest';
import { openFileFrom } from '../../src/lib/changeCounts.js';

// A tap on a file in the phone pop-up opens Novi on that file.
describe('opening a file from the phone pop-up', () => {
  const changes = { id: 'v1', files: [{ file: 'src/a.js' }] };
  it('opens a file of this card', () => {
    expect(openFileFrom('?changes=v1&file=src%2Fa.js', changes)).toBe('src/a.js');
  });
  it('ignores another card or a file not on it', () => {
    expect(openFileFrom('?changes=v2&file=src%2Fa.js', changes)).toBe(null);
    expect(openFileFrom('?changes=v1&file=.env', changes)).toBe(null);
    expect(openFileFrom('', changes)).toBe(null);
  });
});
