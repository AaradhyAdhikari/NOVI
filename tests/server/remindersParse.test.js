import { describe, it, expect } from 'vitest';
import { parseWhen, describeTime, nextOccurrence } from '../../plugins/reminders/parse.js';

// Saturday 3 October 2026, 2:30 pm local time
const NOW = new Date(2026, 9, 3, 14, 30, 0, 0);
const at = (...args) => new Date(...args).getTime();
const when = (text, now = NOW) => {
  const r = parseWhen(text, now);
  return r && { at: r.at.getTime(), rolled: r.rolled };
};

describe('parseWhen: relative times', () => {
  it('understands "in N minutes/hours/seconds"', () => {
    expect(when('in 10 minutes')).toEqual({ at: at(2026, 9, 3, 14, 40), rolled: false });
    expect(when('in 20 mins')).toEqual({ at: at(2026, 9, 3, 14, 50), rolled: false });
    expect(when('in an hour')).toEqual({ at: at(2026, 9, 3, 15, 30), rolled: false });
    expect(when('in half an hour')).toEqual({ at: at(2026, 9, 3, 15, 0), rolled: false });
    expect(when('in 2 hours')).toEqual({ at: at(2026, 9, 3, 16, 30), rolled: false });
    expect(when('in 90 seconds')).toEqual({ at: at(2026, 9, 3, 14, 31, 30), rolled: false });
    expect(when('in a minute')).toEqual({ at: at(2026, 9, 3, 14, 31), rolled: false });
  });
});

describe('parseWhen: clock times today', () => {
  it('picks the next matching time when am/pm is not said', () => {
    expect(when('at 6')).toEqual({ at: at(2026, 9, 3, 18, 0), rolled: false });
    expect(when('at 9')).toEqual({ at: at(2026, 9, 3, 21, 0), rolled: false });
  });

  it('rolls to tomorrow (and says so) when the time already passed', () => {
    expect(when('at 2')).toEqual({ at: at(2026, 9, 4, 2, 0), rolled: true });
    expect(when('9:15 am')).toEqual({ at: at(2026, 9, 4, 9, 15), rolled: true });
    expect(when('noon')).toEqual({ at: at(2026, 9, 4, 12, 0), rolled: true });
    expect(when('midnight')).toEqual({ at: at(2026, 9, 4, 0, 0), rolled: true });
  });

  it('understands explicit am/pm and 24-hour times', () => {
    expect(when('at 6 pm')).toEqual({ at: at(2026, 9, 3, 18, 0), rolled: false });
    expect(when('6:30 pm')).toEqual({ at: at(2026, 9, 3, 18, 30), rolled: false });
    expect(when('at 6:30 p.m.')).toEqual({ at: at(2026, 9, 3, 18, 30), rolled: false });
    expect(when('18:00')).toEqual({ at: at(2026, 9, 3, 18, 0), rolled: false });
    expect(when('tonight at 9')).toEqual({ at: at(2026, 9, 3, 21, 0), rolled: false });
  });
});

describe('parseWhen: other days', () => {
  it('understands tomorrow, weekdays and dates', () => {
    expect(when('tomorrow at 9')).toEqual({ at: at(2026, 9, 4, 9, 0), rolled: false });
    expect(when('tomorrow at 5')).toEqual({ at: at(2026, 9, 4, 17, 0), rolled: false });
    expect(when('tomorrow 7:30 pm')).toEqual({ at: at(2026, 9, 4, 19, 30), rolled: false });
    expect(when('at 9 tomorrow')).toEqual({ at: at(2026, 9, 4, 9, 0), rolled: false });
    expect(when('monday at 5')).toEqual({ at: at(2026, 9, 5, 17, 0), rolled: false });
    expect(when('on saturday at 10am')).toEqual({ at: at(2026, 9, 10, 10, 0), rolled: false });
    expect(when('2026-10-10 08:00')).toEqual({ at: at(2026, 9, 10, 8, 0), rolled: false });
  });

  it('crosses month boundaries', () => {
    const late = new Date(2026, 9, 31, 23, 50);
    expect(when('in 20 minutes', late)).toEqual({ at: at(2026, 10, 1, 0, 10), rolled: false });
    expect(when('tomorrow at 9', late)).toEqual({ at: at(2026, 10, 1, 9, 0), rolled: false });
  });

  it('rejects what it cannot understand', () => {
    for (const t of ['', 'whenever', 'at 25', 'in 0 minutes', '13:75', 'today at 2 am', '2020-01-01 10:00']) expect(parseWhen(t, NOW), t).toBeNull();
  });
});

describe('describeTime', () => {
  it('speaks times naturally', () => {
    const d = (...a) => describeTime(new Date(...a), NOW);
    expect(d(2026, 9, 3, 18, 0)).toBe('6:00 pm today');
    expect(d(2026, 9, 4, 9, 0)).toBe('9:00 am tomorrow');
    expect(d(2026, 9, 5, 17, 0)).toBe('Monday 5:00 pm');
    expect(d(2026, 9, 20, 8, 0)).toBe('20 Oct 8:00 am');
  });
});

describe('nextOccurrence', () => {
  it('repeats daily and on weekdays', () => {
    expect(nextOccurrence(new Date(2026, 9, 3, 8, 0), 'daily').getTime()).toBe(at(2026, 9, 4, 8, 0));
    expect(nextOccurrence(new Date(2026, 9, 2, 9, 0), 'weekdays').getTime()).toBe(at(2026, 9, 5, 9, 0)); // Fri → Mon
    expect(nextOccurrence(new Date(2026, 9, 5, 9, 0), 'weekdays').getTime()).toBe(at(2026, 9, 6, 9, 0)); // Mon → Tue
  });
});
