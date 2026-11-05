import { describe, it, expect } from 'vitest';
import { phonePage } from '../../plugins/codemap/phonePage.js';

// Live 2026-11-05: on a phone graphify's 280 px side panel took most of the screen and the map was a thin strip.
const PAGE = '<html><head><title>x</title></head><body><div id="graph"></div><div id="sidebar"></div><script>const network = 1;</script></body></html>';

describe('the code map on a phone', () => {
  it('fits the phone and hides the panel until asked', () => {
    const html = phonePage(PAGE);
    expect(html).toContain('name="viewport"');
    expect(html).toMatch(/@media \(max-width: ?700px\)/);
    expect(html).toContain('translateX(100%)');
  });
  it('has a button for the panel, and a tapped dot opens it', () => {
    const html = phonePage(PAGE);
    expect(html).toContain('id="novi-details"');
    expect(html).toContain("network.on('selectNode'");
  });
  it('adds to the page, never changes what is in it', () => {
    const html = phonePage(PAGE);
    expect(html).toContain('<div id="graph"></div><div id="sidebar"></div><script>const network = 1;</script>');
    expect(html.indexOf('name="viewport"')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('id="novi-details"')).toBeGreaterThan(html.indexOf('const network'));
  });
  it('a page that already has a viewport keeps just the one', () => {
    const html = phonePage(PAGE.replace('<title>', '<meta name="viewport" content="width=device-width"><title>'));
    expect(html.match(/name="viewport"/g)).toHaveLength(1);
  });
});
