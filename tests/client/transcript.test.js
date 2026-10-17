import { describe, it, expect } from 'vitest';
import { mergeTranscript } from '../../src/lib/transcript.js';

describe('mergeTranscript (a refresh must not erase pictures, videos or links)', () => {
  it('keeps the picture / video / link the page already has for the same entry', () => {
    const shown = [
      { role: 'user', text: 'graph', at: 't1' },
      { role: 'novi', text: 'octo: 2 contributions', at: 't2', image: 'data:image/svg+xml;base64,AAA' },
      { role: 'novi', text: 'Valorant', at: 't3', video: 'abc' },
    ];
    const fromServer = [
      { role: 'user', text: 'graph', at: 't1' },
      { role: 'novi', text: 'octo: 2 contributions', at: 't2' },
      { role: 'novi', text: 'Valorant', at: 't3', video: 'abc' },
      { role: 'novi', text: 'Here it is.', at: 't4' },
    ];
    const merged = mergeTranscript(shown, fromServer);
    expect(merged[1].image).toBe('data:image/svg+xml;base64,AAA');
    expect(merged.map((e) => e.text)).toEqual(['graph', 'octo: 2 contributions', 'Valorant', 'Here it is.']);
  });

  it('uses the server list as is when nothing was shown yet', () => {
    expect(mergeTranscript([], [{ role: 'novi', text: 'hi', at: 't1' }])).toEqual([{ role: 'novi', text: 'hi', at: 't1' }]);
    expect(mergeTranscript([{ role: 'novi', text: 'x', at: 't' }], undefined)).toEqual([{ role: 'novi', text: 'x', at: 't' }]);
  });
});

describe('chat extras (2026-10-17)', () => {
  it('a code card the page already has survives a refresh', async () => {
    const { mergeTranscript } = await import('../../src/lib/transcript.js');
    const code = { id: 'c1', file: 'contact.html', start: 1, text: '<form/>' };
    const shown = [{ role: 'novi', text: 'site · contact.html', at: 't', code }];
    expect(mergeTranscript(shown, [{ role: 'novi', text: 'site · contact.html', at: 't' }])[0].code).toEqual(code);
  });

  it('link labels never say "Open Open …"', async () => {
    const { linkLabel } = await import('../../src/lib/transcript.js');
    expect(linkLabel('Open the portfolio homepage live')).toBe('Open the portfolio homepage live');
    expect(linkLabel('the portfolio site')).toBe('Open the portfolio site');
  });
});
