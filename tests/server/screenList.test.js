import { describe, it, expect } from 'vitest';
import { screenList } from '../../plugins/screen/index.js';

describe('the list of what is on screen', () => {
  it("puts the page's own items first and the browser's buttons last (live: the list began with Minimize, Back, Reload…)", () => {
    const at = (type, name, y) => ({ type, name, x: 10, y });
    const list = screenList([
      at('button', 'Minimize', 1), at('button', 'Back', 2), at('button', 'Reload', 3), at('box', 'Address and search bar', 4),
      at('button', 'Zoom: 67%', 5), at('button', 'Brave Shields', 6), at('link', 'snaxgaming', 300), at('button', 'Subscribe', 320),
    ]);
    expect(list.map((i) => i.name)).toEqual(['snaxgaming', 'Subscribe', 'Minimize', 'Back', 'Reload', 'Address and search bar', 'Zoom: 67%', 'Brave Shields']);
  });
});
