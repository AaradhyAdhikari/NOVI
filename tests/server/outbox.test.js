import { describe, it, expect } from 'vitest';
import { queue, due } from '../../src/lib/outbox.js';

// Live 2026-11-10: a message typed while Novi was restarting vanished without a word (the page only sent while
// connected). Now it waits on the phone and goes out by itself when Novi is back.
describe('messages typed while Novi is away', () => {
  it('wait in order and go out when Novi is back', () => {
    let box = [];
    box = queue(box, { type: 'user_message', text: 'a' }, 1000);
    box = queue(box, { type: 'user_message', text: 'b' }, 2000);
    expect(due(box, 3000).map((m) => m.text)).toEqual(['a', 'b']);
  });
  it('keep at most 10, and drop ones older than 10 minutes', () => {
    let box = [];
    for (let i = 0; i < 12; i += 1) box = queue(box, { type: 'user_message', text: String(i) }, i);
    expect(box).toHaveLength(10);
    expect(due(box, 10 * 60_000 + 5).map((m) => m.text)).toEqual(['6', '7', '8', '9', '10', '11']);
  });
});
