import { describe, it, expect } from 'vitest';
import { normalPriority } from '../../server/priority.js';

// Live 2026-11-08: the Windows logon task starts Novi at below-normal priority, and every Edge it started
// inherited it: the remote-control video took 16 s inside Novi, 3 s from a plain script.
describe('Novi runs at normal priority', () => {
  it('raises a process to normal and says so', () => {
    const calls = [];
    expect(normalPriority(42, { get: () => 10, set: (pid, p) => calls.push([pid, p]) })).toBe('raised');
    expect(calls).toEqual([[42, 0]]);
  });
  it('leaves one already at normal or higher alone, and never fails', () => {
    expect(normalPriority(1, { get: () => 0, set: () => { throw new Error('no'); } })).toBe('normal');
    expect(normalPriority(1, { get: () => -7, set: () => { throw new Error('no'); } })).toBe('normal');
    expect(normalPriority(1, { get: () => 10, set: () => { throw new Error('denied'); } })).toBe('left');
  });
});
