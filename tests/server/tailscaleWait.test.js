import { describe, it, expect } from 'vitest';
import { waitForTailscale } from '../../server/tailscale.js';

// Live 2026-11-04: Novi started with Windows before Tailscale was up, kept its home-made certificate
// all day, and the phone app showed a blank white page.
describe('Tailscale coming up after Novi', () => {
  const clock = () => {
    const due = [];
    return { setTimer: (fn) => { due.push(fn); return due.length; }, tick: async () => { await due.shift()?.(); }, left: () => due.length };
  };

  it('keeps checking, and tells Novi once when the certificate is there', async () => {
    const c = clock();
    const answers = [null, null, { name: 'x.ts.net' }];
    const found = [];
    waitForTailscale({ check: async () => answers.shift(), onFound: (t) => found.push(t), setTimer: c.setTimer });
    await c.tick();
    await c.tick();
    expect(found).toEqual([]);
    await c.tick();
    expect(found).toEqual([{ name: 'x.ts.net' }]);
    expect(c.left()).toBe(0);
  });

  it('a failed check just waits for the next one', async () => {
    const c = clock();
    let n = 0;
    const found = [];
    waitForTailscale({ check: async () => { n += 1; if (n === 1) throw new Error('down'); return { name: 'y' }; }, onFound: (t) => found.push(t), setTimer: c.setTimer });
    await c.tick();
    await c.tick();
    expect(found.length).toBe(1);
  });

  it('gives up after its tries, so a laptop without Tailscale is left in peace', async () => {
    const c = clock();
    let n = 0;
    waitForTailscale({ check: async () => { n += 1; return null; }, onFound: () => {}, setTimer: c.setTimer, tries: 3 });
    for (let i = 0; i < 6; i++) await c.tick();
    expect(n).toBe(3);
    expect(c.left()).toBe(0);
  });
});
