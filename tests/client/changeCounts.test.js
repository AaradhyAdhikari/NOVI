import { describe, it, expect } from 'vitest';
import { countParts } from '../../src/lib/changeCounts.js';

describe('the counts beside a file on the card', () => {
  it('pluses and minuses separately, so each gets its colour', () => {
    expect(countParts({ file: 'a.js', added: 20, removed: 3 })).toEqual([{ kind: 'plus', text: '+20' }, { kind: 'minus', text: '−3' }]);
  });
  it('leaves out a zero', () => {
    expect(countParts({ file: 'a.js', added: 5, removed: 0 })).toEqual([{ kind: 'plus', text: '+5' }]);
    expect(countParts({ file: 'a.js', added: 0, removed: 7 })).toEqual([{ kind: 'minus', text: '−7' }]);
  });
  it('new files and pictures say so', () => {
    expect(countParts({ file: 'a.js', isNew: true })).toEqual([{ kind: 'plus', text: 'new' }]);
    expect(countParts({ file: 'a.png' })).toEqual([{ kind: 'muted', text: 'changed' }]);
  });
});
