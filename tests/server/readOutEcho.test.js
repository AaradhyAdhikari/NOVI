import { describe, it, expect } from 'vitest';
import { withoutReadOut, createReadOuts } from '../../server/voice/echo.js';

const LINE = 'Claude asks: Which colour should the test button be? One, Blue. Two, Green. Three, Red. Or say: other, and your own answer.';

// Live 2026-11-04: the laptop mic heard the answer and then the phone reading the card, and all of it went
// to Claude as the answer.
describe('taking Novi\'s own read-out out of what the mic heard', () => {
  it('keeps the answer and drops the read-out after it', () => {
    expect(withoutReadOut('Option 2. Green. 2. Green. 3. Red. Or say other. And your answer.', [LINE])).toBe('Option 2. Green.');
  });
  it('leaves an answer that shares a word or two with the card', () => {
    expect(withoutReadOut('Option 2 green', [LINE])).toBe('Option 2 green');
    expect(withoutReadOut('Go ahead', ['Claude\'s plan is ready. Go ahead?'])).toBe('Go ahead');
  });
  it('a mishearing of the read-out still counts ("Best of Nobi cards")', () => {
    expect(withoutReadOut('Best of Nobi cards.', ['NOVI: say hello as a test of Novi cards.'])).toBe('');
  });
  it('while Novi reads, even a short slice of the read-out is hers, never an answer', () => {
    expect(withoutReadOut('Two, Green.', [LINE], { reading: true })).toBe('');
    expect(withoutReadOut('Three.', [LINE], { reading: true })).toBe('');
    expect(withoutReadOut('Option two.', [LINE], { reading: true })).toBe('Option two.');
    expect(withoutReadOut('Yes.', ['NOVI: run the tests.'], { reading: true })).toBe('Yes.');
  });
});

describe('a slow voice or a mishearing', () => {
  it('while she reads, any clip made only of her words is hers, in any order', () => {
    expect(withoutReadOut('Goa head', ['The plan is ready. Go ahead?'], { reading: true })).toBe('Goa head'); // not her words
    expect(withoutReadOut('Green two', [LINE], { reading: true })).toBe('');
  });
  it('the reading time has a margin for a voice that starts late', () => {
    let t = 0;
    const r = createReadOuts({ now: () => t });
    const ms = r.add(['The plan is ready. Go ahead?']);
    t = ms + 2000;
    expect(r.reading()).toBe(true);
    expect(r.strip('Go ahead').text).toBe('');
  });
});

describe('the read-outs in the air', () => {
  it('are remembered while they play and a little after', () => {
    let t = 0;
    const r = createReadOuts({ now: () => t });
    r.add([LINE]);
    expect(r.reading()).toBe(true);
    expect(r.strip('Two, Green.')).toEqual({ text: '', removed: true });
    t = 18_000; // read-out over
    expect(r.reading()).toBe(false);
    expect(r.strip('Two, Green.')).toEqual({ text: 'Two, Green.', removed: false });
    expect(r.strip('Which colour should the test button be').text).toBe('');
    t = 60_000; // long gone: nothing is touched
    expect(r.strip('Which colour should the test button be').removed).toBe(false);
  });
  it('a read-out that was answered is over', () => {
    let t = 0;
    const r = createReadOuts({ now: () => t });
    r.add([LINE]);
    r.done();
    expect(r.reading()).toBe(false);
    expect(r.strip('Which colour should the test button be').text).toBe(''); // its tail may still be in the room
  });
  it('says how long the longest line takes', () => {
    const r = createReadOuts({ now: () => 0 });
    expect(r.add(['short', LINE])).toBeGreaterThan(8000);
  });
});
