import { describe, it, expect } from 'vitest';
import { parseWake, WakeListener, expectsAnswer } from '../../src/lib/wake.js';

describe('parseWake', () => {
  it('finds "Hey Novi" with or without a command', () => {
    expect(parseWake('Hey Novi, play lofi on YouTube')).toEqual({ command: 'play lofi on YouTube' });
    expect(parseWake('hey novi')).toEqual({ command: '' });
    expect(parseWake('OK Novi what time is it')).toEqual({ command: 'what time is it' });
    expect(parseWake('Novi, open calculator.')).toEqual({ command: 'open calculator.' });
  });

  it('accepts common mis-hearings of "Novi" after a greeting', () => {
    for (const t of ['hey navi open github', 'hey novy open github', 'hey nobi open github', 'hi novi open github', 'hey Nova open github']) {
      expect(parseWake(t), t).toEqual({ command: 'open github' });
    }
  });

  it('ignores ordinary speech', () => {
    for (const t of ['I watched a movie', 'the navy is here', 'innovation is great', 'nova scotia is cold', '']) expect(parseWake(t), t).toBeNull();
  });
});

describe('WakeListener', () => {
  function listener() {
    let t = 0;
    const l = new WakeListener({ followUpMs: 8000, now: () => t });
    return { l, advance: (ms) => { t += ms; } };
  }

  it('runs a command said with the wake word', () => {
    const { l } = listener();
    expect(l.handle('hey novi open calculator')).toEqual({ command: 'open calculator' });
  });

  it('after "Hey Novi" alone, the next phrase is the command', () => {
    const { l, advance } = listener();
    expect(l.handle('hey novi')).toEqual({ wake: true });
    advance(3000);
    expect(l.handle('what time is it')).toEqual({ command: 'what time is it' });
    expect(l.handle('what time is it')).toBeNull();
  });

  it('a follow-up window accepts an answer without the wake word, then closes', () => {
    const { l, advance } = listener();
    l.openFollowUp();
    advance(5000);
    expect(l.handle('use Claude instead')).toEqual({ command: 'use Claude instead' });
    l.openFollowUp();
    advance(9000);
    expect(l.handle('yes')).toBeNull();
  });

  it('ignores background talk when no window is open', () => {
    const { l } = listener();
    expect(l.handle('pass me the salt')).toBeNull();
  });
});

describe('expectsAnswer', () => {
  it('detects when Novi asked something', () => {
    expect(expectsAnswer('Shall I start? Say yes, no, or use Claude instead.')).toBe(true);
    expect(expectsAnswer('Novi Coder wants to run: npm test. Should I allow it?')).toBe(true);
    expect(expectsAnswer('Which account: personal or college?')).toBe(true);
    expect(expectsAnswer('Calculator is open.')).toBe(false);
  });
});

describe('parseWake (looser matching)', () => {
  it('finds the wake word after leading words and with more mis-hearings', () => {
    expect(parseWake('okay so hey Novi open calculator')).toEqual({ command: 'open calculator' });
    expect(parseWake('Hey Navy, what time is it')).toEqual({ command: 'what time is it' });
    expect(parseWake('hey movie play lofi')).toEqual({ command: 'play lofi' });
    expect(parseWake('heynovi open github')).toEqual({ command: 'open github' });
    expect(parseWake('hey Novi.')).toEqual({ command: '' });
  });
});

describe('parseWake (sound-alike matching)', () => {
  it('accepts spellings that sound like "Novi"', () => {
    for (const name of ['Novey', 'novee', 'nobi', 'noby', 'nevi', 'naavi', 'nowy', 'novi', 'Navy', 'Nova']) {
      expect(parseWake(`hey ${name} open github`), name).toEqual({ command: 'open github' });
    }
    expect(parseWake('Novey, open calculator')).toEqual({ command: 'open calculator' });
  });

  it('still ignores unrelated words after a greeting', () => {
    for (const t of ['hey everyone', 'hey novel idea', 'okay now', 'hi nobody is home', 'hey never mind']) expect(parseWake(t), t).toBeNull();
  });
});
