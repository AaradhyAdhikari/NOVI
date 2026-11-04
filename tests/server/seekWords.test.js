import { describe, it, expect } from 'vitest';
import { controlCommand } from '../../server/brain/controlCommand.js';

const to = (t) => controlCommand(t)?.args?.to;

// Timestamps as they are said and as Whisper writes them (live 2026-11-04).
describe('going to a time in a video', () => {
  it('takes every way of saying it', () => {
    expect(to('go to 2:30')).toBe(150);
    expect(to('go to 2.30')).toBe(150);
    expect(to('jump to 1:02:03')).toBe(3723);
    expect(to('jump to 1 minute 15 seconds')).toBe(75);
    expect(to('go to 30 seconds')).toBe(30);
    expect(to('skip to 1 hour 5 minutes')).toBe(3900);
    expect(to('go to two minutes')).toBe(120);
    expect(to('go to minute 12')).toBe(720);
    expect(to('go to timestamp 2:30')).toBe(150);
    expect(to('go to the 5 minute mark')).toBe(300);
  });
  it('leaves other "go to" alone', () => {
    for (const t of ['go to chrome', 'go to sleep in 5 minutes', 'go to the second tab']) expect(to(t), t).toBe(undefined);
  });
});
