import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { isBlankPicture, pageShot } from '../../plugins/screen/pageShot.js';

const fixture = (f) => fs.readFileSync(new URL(`../fixtures/${f}`, import.meta.url));
const blank = fixture('preview-blank.png');
const page = fixture('preview-page.png');

// Live (2026-10-17): "show me the homepage" sent an all-black picture of a site that worked.
describe('page pictures', () => {
  it('tells a blank (one-colour) picture from a real page', () => {
    expect(isBlankPicture(blank)).toBe(true);
    expect(isBlankPicture(page)).toBe(false);
    expect(isBlankPicture(Buffer.from('not a png'))).toBe(false); // unknown → keep it
  });

  it('a blank picture is taken again, with more time and reduced motion', async () => {
    const calls = [];
    const shoot = async (url, opts) => { calls.push(opts); return calls.length === 1 ? blank : page; };
    const { png } = await pageShot('http://localhost:1/', { width: 390, height: 844, shoot, retryDelayMs: 0 });
    expect(png).toBe(page);
    expect(calls).toHaveLength(2);
    expect(calls[1].retry).toBe(true);
  });

  it('still blank after the retry: says so instead of sending a black picture', async () => {
    const shoot = async () => blank;
    await expect(pageShot('http://localhost:1/', { shoot, retryDelayMs: 0 })).rejects.toMatchObject({ blank: true, message: expect.stringMatching(/blank/i) });
  });
});
