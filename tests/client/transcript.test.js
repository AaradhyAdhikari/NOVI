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
