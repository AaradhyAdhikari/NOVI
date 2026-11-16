import { describe, it, expect } from 'vitest';
import { isFlick, flickRequest, wantsFlick, itemKind, createFlickDetector, motionSample } from '../../src/lib/flickGesture.js';

// The phone side of Novi Flick: what counts as a flick, and how an item is sent.
describe('the flick gesture', () => {
  it('a quick or long swipe up is a flick; a small or slow drag, or down, is not', () => {
    expect(isFlick({ dy: -140, ms: 400 })).toBe(true);   // long
    expect(isFlick({ dy: -60, ms: 70 })).toBe(true);     // short but fast
    expect(isFlick({ dy: -30, ms: 300 })).toBe(false);
    expect(isFlick({ dy: -60, ms: 600 })).toBe(false);
    expect(isFlick({ dy: 200, ms: 100 })).toBe(false);
  });
  it('files go as bytes with their name and type in headers; links as text', () => {
    const file = { name: 'Résumé 2026.pdf', type: 'application/pdf' };
    const f = flickRequest({ file });
    expect(f.url).toBe('/api/plugin-upload/flick');
    expect(f.init.method).toBe('POST');
    expect(f.init.body).toBe(file);
    expect(f.init.headers['x-novi-name']).toBe(encodeURIComponent('Résumé 2026.pdf'));
    expect(f.init.headers['x-novi-type']).toBe('application/pdf');
    expect(f.init.headers['content-type']).toBe('application/octet-stream'); // never parsed as JSON on the way
    const l = flickRequest({ link: 'https://youtu.be/x' });
    expect(l.init.body).toBe('https://youtu.be/x');
    expect(l.init.headers['x-novi-kind']).toBe('link');
  });
  it('kinds for the card', () => {
    expect(itemKind({ file: { name: 'a.jpg', type: 'image/jpeg' } })).toBe('photo');
    expect(itemKind({ file: { name: 'a.mp4', type: 'video/mp4' } })).toBe('video');
    expect(itemKind({ file: { name: 'a.pdf', type: '' } })).toBe('doc');
    expect(itemKind({ link: 'https://x.com' })).toBe('link');
  });
  it('?flick opens the flick screen', () => {
    expect(wantsFlick('?flick')).toBe(true);
  });
});

// Recorded-style motion shapes, 20 ms apart (50 Hz, like the phone's game-rate sensors).
const shape = (parts) => { const out = []; let t = 0; for (const [ms, f] of parts) for (let i = 0; i < ms; i += 20, t += 20) out.push({ t, ...f(i / ms) }); return out; };
const fires = (samples, d = createFlickDetector()) => samples.filter((s) => d.feed(s)).length;
const still = [400, () => ({ acc: 0.4, rx: 4, ry: 3, rz: 2 })];
describe('the wrist flick', () => {
  it('a quick forward flick after holding the phone still fires once', () => {
    const flick = shape([still, [160, (p) => ({ acc: 22 * Math.sin(Math.PI * p), rx: -380 * Math.sin(Math.PI * p), ry: 60, rz: 40 })], [400, () => ({ acc: 1, rx: 10, ry: 5, rz: 5 })]]);
    expect(fires(flick)).toBe(1);
  });
  it('walking, a bump on the table, a twist and a hard shake do not', () => {
    const walk = shape([[3000, (p) => ({ acc: 3.5 + 3.5 * Math.sin(p * 2 * Math.PI * 6), rx: 70 * Math.sin(p * 2 * Math.PI * 6), ry: 40, rz: 30 })]]);
    expect(fires(walk)).toBe(0);
    const bump = shape([still, [60, () => ({ acc: 28, rx: 35, ry: 20, rz: 15 })], still]);
    expect(fires(bump)).toBe(0);
    const twist = shape([still, [200, (p) => ({ acc: 16 * Math.sin(Math.PI * p), rx: 90, ry: 60, rz: 420 * Math.sin(Math.PI * p) })], still]);
    expect(fires(twist)).toBe(0);
    // A shake keeps going with no stillness in between: at most the first jolt, never a stream of sends.
    const shake = shape([still, [2000, (p) => ({ acc: 18, rx: 320 * Math.sign(Math.sin(p * 2 * Math.PI * 8)), ry: 50, rz: 50 })]]);
    expect(fires(shake)).toBeLessThanOrEqual(1);
  });
  it('two flicks need 1.5 s between them', () => {
    const one = [still, [160, (p) => ({ acc: 22 * Math.sin(Math.PI * p), rx: 380 * Math.sin(Math.PI * p), ry: 0, rz: 0 })]];
    expect(fires(shape([...one, ...one]))).toBe(1);
    expect(fires(shape([...one, [1600, () => ({ acc: 0.4, rx: 2, ry: 2, rz: 2 })], ...one]))).toBe(2);
  });
  it('browser motion events become samples (rotationRate in °/s, beta = the pitch)', () => {
    expect(motionSample({ acceleration: { x: 3, y: 4, z: 0 }, rotationRate: { alpha: 1, beta: 300, gamma: 2 } }, 5)).toEqual({ t: 5, acc: 5, rx: 300, ry: 2, rz: 1 });
    expect(motionSample({ acceleration: null, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 }, rotationRate: null }, 1).acc).toBeCloseTo(0);
  });
  it('flick status words', () => {
    expect(wantsFlick('?flick')).toBe(true);
    expect(wantsFlick('?memory')).toBe(false);
  });
});
