import { describe, it, expect } from 'vitest';
import { pinchView, panView, tapResult } from '../../src/lib/zoom.js';

const size = { w: 400, h: 800 };
const flat = { zoom: 1, x: 0, y: 0 };

describe('zooming a picture', () => {
  it('fingers apart zoom in, keeping the spot between them in place', () => {
    const v = pinchView({ view: flat, gap: 100, mid: { x: 100, y: 0 } }, 200, { x: 100, y: 0 }, size);
    expect(v).toEqual({ zoom: 2, x: -100, y: 0 });
  });
  it('fingers together zoom back out, and never below the whole picture', () => {
    expect(pinchView({ view: { zoom: 2, x: -100, y: 0 }, gap: 200, mid: { x: 0, y: 0 } }, 50, { x: 0, y: 0 }, size)).toEqual(flat);
  });
  it('stops at 5 times', () => {
    expect(pinchView({ view: flat, gap: 10, mid: { x: 0, y: 0 } }, 500, { x: 0, y: 0 }, size).zoom).toBe(5);
  });
  it('one finger moves a zoomed picture, but not past its edge', () => {
    const v = { zoom: 2, x: 0, y: 0 };
    expect(panView(v, 50, -30, size)).toEqual({ zoom: 2, x: 50, y: -30 });
    expect(panView(v, 5000, 0, size).x).toBe(200);
  });
  it('a picture at normal size does not move', () => {
    expect(panView(flat, 50, 50, size)).toEqual(flat);
  });
});

describe('tapping a picture', () => {
  it('one tap closes it at normal size, and does nothing while zoomed', () => {
    expect(tapResult(flat, false)).toBe('close');
    expect(tapResult({ zoom: 2, x: 0, y: 0 }, false)).toBe('none');
  });
  it('a double tap zooms in, or back out', () => {
    expect(tapResult(flat, true)).toBe('zoom');
    expect(tapResult({ zoom: 2, x: 0, y: 0 }, true)).toBe('reset');
  });
});
