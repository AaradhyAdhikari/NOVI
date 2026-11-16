import { describe, it, expect } from 'vitest';
import { isFlick, flickRequest, wantsFlick, itemKind } from '../../src/lib/flickGesture.js';

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
    expect(wantsFlick('?memory')).toBe(false);
  });
});
