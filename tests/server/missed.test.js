import { describe, it, expect } from 'vitest';
import { createMissedQueue } from '../../server/missed.js';

describe('missed queue', () => {
  it('keeps the last lines per phone and hands them over once', () => {
    const q = createMissedQueue({ max: 3 });
    for (const t of ['a', 'b', 'c', 'd']) q.add('d1', t);
    q.add('d2', 'x');
    expect(q.take('d1')).toEqual(['b', 'c', 'd']);
    expect(q.take('d1')).toEqual([]);
    q.clear('d2');
    expect(q.take('d2')).toEqual([]);
  });
});
