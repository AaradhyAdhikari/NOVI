import { describe, it, expect } from 'vitest';
import { cleanDictation } from '../../server/voice/dictationCleanup.js';

// Dictation clean-up (rules only): fillers, stutters, spacing, capitals. Never an ending full stop.
describe('cleanDictation', () => {
  it('drops fillers and capitalises', () => {
    expect(cleanDictation('um so i think uh we should go')).toBe('So I think we should go');
    expect(cleanDictation('hmm okay. that works')).toBe('Okay. That works');
    expect(cleanDictation('it was, you know, fine')).toBe('It was, fine');
  });
  it('keeps words that only look like fillers', () => {
    expect(cleanDictation('humble umbrella')).toBe('Humble umbrella');
  });
  it('drops stutters but keeps real doubles', () => {
    expect(cleanDictation('the the meeting is at five')).toBe('The meeting is at five');
    expect(cleanDictation('he had had enough')).toBe('He had had enough');
  });
  it('tidies spacing around punctuation', () => {
    expect(cleanDictation('hello , world')).toBe('Hello, world');
  });
  it('leaves Hinglish alone and never adds a full stop', () => {
    expect(cleanDictation('kal milte hain')).toBe('Kal milte hain');
    expect(cleanDictation('mera naam uh Aaradhy hai')).toBe('Mera naam Aaradhy hai');
  });
  it('handles empty input', () => {
    expect(cleanDictation('')).toBe('');
    expect(cleanDictation(undefined)).toBe('');
  });
  it('spoken punctuation is opt-in', () => {
    const said = 'hello comma how are you question mark new line fine full stop';
    expect(cleanDictation(said)).toBe('Hello comma how are you question mark new line fine full stop');
    expect(cleanDictation(said, { spokenPunctuation: true })).toBe('Hello, how are you?\nFine.');
  });
});
