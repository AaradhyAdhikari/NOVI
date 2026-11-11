import { describe, it, expect } from 'vitest';
import { fixOpenWords, closestName, soundKey, correctionOf } from '../../server/voice/soundAlike.js';
import { siteNames } from '../../server/brain/browseCommand.js';

// Live 2026-11-11: "open perplexity" was heard as "open public City" five times and nothing opened.
const names = ['Perplexity', 'Pinterest', 'Photos', 'PowerPoint', 'Paint', 'Phone Link', 'Notepad', 'Spotify', 'WhatsApp', 'Gemini', 'Claude', 'Portfolio', 'Settings', 'Chrome'];

describe('names that sound alike', () => {
  it('a rough sound key', () => {
    expect(soundKey('perplexity')).toBe('prplkst');
    expect(soundKey('Spotify')).toBe('sptf');
  });
  it('fixes the name after "open" to a known app or site', () => {
    expect(fixOpenWords('open public City', names)).toBe('open Perplexity');
    expect(fixOpenWords('Open spotty fy.', names)).toBe('Open Spotify.');
    expect(fixOpenWords('okay open what sap on my laptop', names)).toBe('okay open WhatsApp on my laptop');
    expect(fixOpenWords('open gemeni', names)).toBe('open Gemini');
  });
  it('leaves right names, unknown words and other sentences alone', () => {
    expect(fixOpenWords('open perplexity', names)).toBe('open perplexity');
    expect(fixOpenWords('open the door to my room please now', names)).toBe('open the door to my room please now');
    expect(fixOpenWords('what is the weather', names)).toBe('what is the weather');
    expect(closestName('xyzzy', names)).toBe(null);
  });
  it('two names just as close: no guess', () => {
    expect(closestName('Mapper', ['Mappers', 'Mapped'])).toBe(null);
  });
});

describe('the user says what they meant', () => {
  it('"I meant X" / "I said X" / "no, X" after an open', () => {
    expect(correctionOf('I meant Perplexity')).toBe('Perplexity');
    expect(correctionOf('No, I said perplexity.')).toBe('perplexity');
    expect(correctionOf('not that, Perplexity')).toBe('Perplexity');
    expect(correctionOf('I meant what I said yesterday about the project and more')).toBe(null);
    expect(correctionOf('open notepad')).toBe(null);
  });
});

describe('known sites', () => {
  it('Perplexity and the other AI sites are known', () => {
    expect(siteNames()).toEqual(expect.arrayContaining(['perplexity', 'gamma', 'deepseek', 'grok', 'kick', 'twitch']));
  });
});

describe('what an open said', () => {
  it('keeps the verb and the name as heard', async () => {
    const { openTarget } = await import('../../server/voice/soundAlike.js');
    expect(openTarget('okay open publicity')).toEqual({ verb: 'open ', target: 'publicity' });
    expect(openTarget('what is the time')).toBe(null);
    expect(correctionOf('no')).toBe(null);
    expect(correctionOf('no, deny it')).toBe(null);
  });
});
