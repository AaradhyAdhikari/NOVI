import { describe, it, expect } from 'vitest';
import { createLaptopState } from '../../server/laptopState.js';

// What the desktop orb shows (2026-10-18): listening / thinking / speaking / quiet / idle on the laptop.
function clock() {
  const timers = [];
  return {
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    fire: () => timers.splice(0).forEach((t) => t.fn()),
    timers,
  };
}

describe('laptop state', () => {
  it('wake → listening, thinking, a spoken line → speaking for about its length, then idle', () => {
    const c = clock();
    const s = createLaptopState(c);
    const seen = [];
    s.on((v) => seen.push(v));
    s.feed({ type: 'wake' });
    s.feed({ type: 'thinking', on: true });
    s.feed({ type: 'thinking', on: false });
    s.feed({ type: 'speak', text: 'Hello there' });
    expect(c.timers[0].ms).toBe(1500 + 70 * 11);
    c.fire();
    expect(seen).toEqual(['idle', 'listening', 'thinking', 'idle', 'speaking', 'idle']);
    s.feed({ type: 'chat' }); // other messages change nothing
    expect(seen).toHaveLength(6);
  });

  it('the laptop speakers count while they talk; stop_speaking ends it; quiet mode shows when idle', () => {
    const s = createLaptopState(clock());
    s.speaking(true);
    expect(s.get()).toBe('speaking');
    s.speaking(false);
    s.feed({ type: 'speak', text: 'x' });
    s.feed({ type: 'stop_speaking' });
    expect(s.get()).toBe('idle');
    s.feed({ type: 'quiet', on: true });
    expect(s.get()).toBe('quiet');
    s.feed({ type: 'wake' });
    expect(s.get()).toBe('listening');
    s.feed({ type: 'wake_timeout' });
    s.feed({ type: 'quiet', on: false });
    expect(s.get()).toBe('idle');
  });
});
