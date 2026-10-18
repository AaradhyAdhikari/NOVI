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
    // Project names Novi knows by herself join them, once each.
    expect(v.prompt('Hey Novi.', ['TraceBite', 'OpenClaw', 'MediKiosk AI'])).toBe('Hey Novi. OpenClaw, Aaradhy, TraceBite, MediKiosk AI.');
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

describe('built-in fix: "cloud" heard for "Claude"', () => {
  it('turns cloud into Claude when it means the app, not Google Cloud or the sky', () => {
    const v = createVocabulary({ file: file() });
    expect(v.apply('open cloud on my laptop')).toBe('open Claude on my laptop');
    expect(v.apply('open Novi in cloud code')).toBe('open Novi in Claude code');
    expect(v.apply('use Cloud instead')).toBe('use Claude instead');
    expect(v.apply('ask clawed to fix the bug')).toBe('ask Claude to fix the bug');
    expect(v.apply('open google cloud console')).toBe('open google cloud console');
    expect(v.apply('upload it to the cloud')).toBe('upload it to the cloud');
    expect(v.apply('cloud storage is full')).toBe('cloud storage is full');
    expect(v.apply('the clouds look dark')).toBe('the clouds look dark');
  });
});


describe('programming language names as speech-to-text writes them', async () => {
  const { fixLanguages, fixLeetCode, fixGitHub } = await import('../../server/voice/vocabulary.js');
  // Live (2026-10-17): "Gidhub" missed the GitHub graph shortcut and went to the (busy) AI.
  it('"gidhub / git hub / get hub" → GitHub', () => {
    for (const t of ['Show me my Gidhub contribution yesterday.', 'my git hub graph', 'open get hub', 'githab stats']) expect(fixGitHub(t), t).toMatch(/GitHub/);
    expect(fixGitHub('git pull from the hub')).toBe('git pull from the hub');
  });
  // Live (2026-10-17): "LeetCode" was misheard.
  it('"lead code / leet court / lit code" → LeetCode', () => {
    for (const t of ["show me today's lead code problem", "today's leet court question", 'my lit code stats', 'open Leak Code', 'leetcode ka problem'])
      expect(fixLeetCode(t), t).toMatch(/LeetCode|leetcode/);
    expect(fixLeetCode('the lead code reviewer')).toBe('the lead code reviewer');
  });
  it('"sea language" = C language, plus C++ and C#', () => {
    expect(fixLanguages('Open sea language folder')).toBe('Open C language folder');
    expect(fixLanguages('open see language notes')).toBe('open C language notes');
    expect(fixLanguages('open the si programming folder')).toBe('open the C programming folder');
    expect(fixLanguages('sea plus plus notes')).toBe('C++ notes');
    expect(fixLanguages('see sharp project')).toBe('C# project');
    expect(fixLanguages('C language')).toBe('C language');
  });
  it('leaves the real sea alone', () => {
    expect(fixLanguages('play sea waves sounds')).toBe('play sea waves sounds');
    expect(fixLanguages('I see')).toBe('I see');
  });
  it('is part of every fix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-voc-'));
    expect(createVocabulary({ file: path.join(dir, 'v.json') }).apply('open sea language folder')).toBe('open C language folder');
  });
});
