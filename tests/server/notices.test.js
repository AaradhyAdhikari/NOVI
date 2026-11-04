import { describe, it, expect } from 'vitest';
import { createNotices } from '../../server/notices.js';

const watch = (n) => {
  const events = [];
  n.on('added', (x) => events.push(['added', x.title]));
  n.on('gone', (x) => events.push(['gone', x.id]));
  return events;
};

// User, 2026-11-05: every finished task as a small card with one OK.
describe('small cards', () => {
  it('stay until OK, on every device', () => {
    const n = createNotices();
    const events = watch(n);
    const card = n.add({ key: 'a', title: 'Claude finished in NOVI', body: 'All tests pass.' });
    expect(n.list().map((x) => x.title)).toEqual(['Claude finished in NOVI']);
    expect(n.ok(card.id)).toBe(true);
    expect(n.list()).toEqual([]);
    expect(events).toEqual([['added', 'Claude finished in NOVI'], ['gone', card.id]]);
  });
  it('a second OK does nothing', () => {
    const n = createNotices();
    const card = n.add({ key: 'a', title: 'x' });
    n.ok(card.id);
    expect(n.ok(card.id)).toBe(false);
  });
  it('one card per project: the newest takes its place', () => {
    const n = createNotices();
    n.add({ key: 'NOVI', title: 'first' });
    n.add({ key: 'Shop', title: 'other' });
    n.add({ key: 'NOVI', title: 'second' });
    expect(n.list().map((x) => x.title)).toEqual(['other', 'second']);
  });
  it('a busy session updates its card quietly: only the first in a minute makes a sound', () => {
    let t = 0;
    const n = createNotices({ now: () => t });
    expect(n.add({ key: 'NOVI', title: 'a' }).repeat).toBe(false);
    t = 30_000;
    expect(n.add({ key: 'NOVI', title: 'b' }).repeat).toBe(true);
    expect(n.add({ key: 'Shop', title: 'c' }).repeat).toBe(false);
    t = 95_000;
    expect(n.add({ key: 'NOVI', title: 'd' }).repeat).toBe(false);
  });
  it('the oldest go when too many pile up', () => {
    const n = createNotices({ limit: 2 });
    for (const key of ['a', 'b', 'c']) n.add({ key, title: key });
    expect(n.list().map((x) => x.title)).toEqual(['b', 'c']);
  });
  it('long words are cut', () => {
    const n = createNotices();
    const card = n.add({ key: 'a', title: 't'.repeat(300), body: 'b'.repeat(300) });
    expect(card.title.length).toBe(120);
    expect(card.body.length).toBe(200);
  });
});
