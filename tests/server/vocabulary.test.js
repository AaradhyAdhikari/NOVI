import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVocabulary } from '../../server/voice/vocabulary.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-vocab-')), 'vocabulary.json');

describe('word list (vocabulary)', () => {
  it('starts empty and keeps what you save', () => {
    const f = file();
    const v = createVocabulary({ file: f });
    expect(v.get()).toEqual({ words: [], fixes: {} });
    v.set({ words: ['OpenClaw', ' Aaradhy ', '', 'OpenClaw'], fixes: { 'open claw': 'OpenClaw', ' novee ': 'Novi', '': 'x' } });
    expect(v.get()).toEqual({ words: ['OpenClaw', 'Aaradhy'], fixes: { 'open claw': 'OpenClaw', novee: 'Novi' } });
    expect(createVocabulary({ file: f }).get()).toEqual(v.get());
  });

  it('refuses lists that are too long for the speech hint', () => {
    const v = createVocabulary({ file: file() });
    expect(() => v.set({ words: Array.from({ length: 61 }, (_, i) => `w${i}`), fixes: {} })).toThrow('At most 60 words.');
    expect(() => v.set({ words: ['x'.repeat(41)], fixes: {} })).toThrow('Words and fixes must be 40 characters or less.');
  });

  it('adds your words to the speech-to-text hint', () => {
    const v = createVocabulary({ file: file() });
    expect(v.prompt('Hey Novi.')).toBe('Hey Novi.');
    v.set({ words: ['OpenClaw', 'Aaradhy'], fixes: {} });
    expect(v.prompt('Hey Novi.')).toBe('Hey Novi. OpenClaw, Aaradhy.');
  });

  it('fixes misheard words: whole words only, any case, longest first', () => {
    const v = createVocabulary({ file: file() });
    v.set({ words: [], fixes: { 'open claw': 'OpenClaw', novee: 'Novi', 'open': 'Open' } });
    expect(v.apply('hey Novee, open claw project')).toBe('hey Novi, OpenClaw project');
    expect(v.apply('the novees are here')).toBe('the novees are here'); // not inside other words
    expect(v.apply('')).toBe('');
  });

  it('works for Hindi and Marathi words too', () => {
    const v = createVocabulary({ file: file() });
    v.set({ words: [], fixes: { 'नोवी': 'Novi' } });
    expect(v.apply('नोवी मौसम बताओ')).toBe('Novi मौसम बताओ');
  });

  it('adds one fix at a time (from the "Wrong" button)', () => {
    const v = createVocabulary({ file: file() });
    v.addFix('open claw', 'OpenClaw');
    expect(v.get().fixes).toEqual({ 'open claw': 'OpenClaw' });
    expect(() => v.addFix(undefined, 'x')).toThrow('Give both the misheard words and the right ones.');
    expect(() => v.addFix('x', ' ')).toThrow('Give both the misheard words and the right ones.');
  });
});
