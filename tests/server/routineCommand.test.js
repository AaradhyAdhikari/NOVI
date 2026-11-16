import { describe, it, expect } from 'vitest';
import { routineCommand } from '../../server/brain/routineCommand.js';

// Routines by voice (2026-11-13): words that make, list, run, pause, resume, remove a routine, or read what
// it said. Reminders keep their own words.
const make = (s) => ({ tool: 'routine_make', args: { said: s } });

describe('making a routine', () => {
  it('a time pattern + something to look at, an event, or "make a routine"', () => {
    for (const s of [
      'every morning at 7 check my github and tell me what changed',
      'every weekday at 9:30 tell me the tip calculator board and the weather',
      'each friday evening sum up what the team did',
      'whenever a coding task finishes show me the board',
      'when a coding task finishes tell me what changed',
      'when the team finishes a task tell me the team status',
      'make a routine that checks my calendar every morning',
      'set up a routine to check my battery every 3 hours',
    ]) expect(routineCommand(s)).toEqual(make(s));
  });
  it('reminders and ordinary sentences are not routines', () => {
    for (const s of ['remind me every morning to drink water', 'every morning tell me the weather', 'every time I open it, it crashes', 'when will it be done', 'every day is a new day']) expect(routineCommand(s)).toBe(null);
  });
});

describe('the rest by name', () => {
  it('list, run, said, pause, resume, remove', () => {
    expect(routineCommand('list my routines')).toEqual({ tool: 'routine_list', args: {} });
    expect(routineCommand('what are my routines?')).toEqual({ tool: 'routine_list', args: {} });
    expect(routineCommand('run the morning github routine now')).toEqual({ tool: 'routine_run', args: { name: 'morning github' } });
    expect(routineCommand('what did the morning github routine say')).toEqual({ tool: 'routine_said', args: { name: 'morning github' } });
    expect(routineCommand('pause the morning github routine')).toEqual({ tool: 'routine_pause', args: { name: 'morning github' } });
    expect(routineCommand('stop the morning github routine')).toEqual({ tool: 'routine_pause', args: { name: 'morning github' } });
    expect(routineCommand('resume the morning github routine')).toEqual({ tool: 'routine_pause', args: { name: 'morning github', resume: true } });
    expect(routineCommand('delete the morning github routine')).toEqual({ tool: 'routine_remove', args: { name: 'morning github' } });
  });
});

describe('known problems', () => {
  it('a statement about what you do is not a routine', () => {
    expect(routineCommand('every day I check my github')).toBe(null);
    expect(routineCommand('every morning we look at the board')).toBe(null);
  });
});
