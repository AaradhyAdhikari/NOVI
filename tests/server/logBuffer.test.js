import { describe, it, expect } from 'vitest';
import { createLogBuffer } from '../../server/logBuffer.js';

describe('log buffer', () => {
  it('keeps the latest warnings and errors and still prints them', () => {
    const printed = [];
    const fakeConsole = { warn: (...a) => printed.push(['warn', ...a]), error: (...a) => printed.push(['error', ...a]), log() {} };
    const buf = createLogBuffer({ limit: 2 });
    buf.capture(fakeConsole);
    fakeConsole.warn('one');
    fakeConsole.error('two', new Error('boom'));
    fakeConsole.warn('three');
    expect(printed).toHaveLength(3);
    const recent = buf.recent();
    expect(recent.map((e) => e.level)).toEqual(['error', 'warn']);
    expect(recent[0].text).toMatch(/two .*boom/);
    expect(recent[1].text).toBe('three');
    expect(recent[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
