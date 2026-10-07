import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpokenPin, RemotePin } from '../../server/remotePin.js';

describe('parseSpokenPin', () => {
  it('reads digits and English / Hindi number words', () => {
    expect(parseSpokenPin('one two three four')).toBe('1234');
    expect(parseSpokenPin('1 2 3 4.')).toBe('1234');
    expect(parseSpokenPin('1234')).toBe('1234');
    expect(parseSpokenPin('ek do teen char')).toBe('1234');
    expect(parseSpokenPin('Nine, oh, five, eight, seven, six.')).toBe('905876');
  });
  it('rejects anything that is not 4–8 digits', () => {
    expect(parseSpokenPin('twelve')).toBeNull();
    expect(parseSpokenPin('123')).toBeNull();
    expect(parseSpokenPin('1 2 3 4 5 6 7 8 9')).toBeNull();
    expect(parseSpokenPin('one two three banana')).toBeNull();
  });
});

describe('RemotePin', () => {
  const make = () => {
    let t = 1_000_000;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-pin-')), 'remote-pin.json');
    const pin = new RemotePin({ file, now: () => t });
    return { pin, file, advance: (ms) => { t += ms; } };
  };

  it('stores only a hash, never the PIN itself', () => {
    const { pin, file } = make();
    pin.set('482913');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('482913');
    expect(pin.isSet()).toBe(true);
  });

  it('rejects PINs that are not 4–8 digits', () => {
    const { pin } = make();
    expect(() => pin.set('12')).toThrow();
    expect(() => pin.set('12ab')).toThrow();
  });

  it('accepts the right PIN and locks for 15 minutes after 3 wrong ones', () => {
    const { pin, advance } = make();
    const locks = [];
    pin.on('locked', (e) => locks.push(e));
    pin.set('4829');
    expect(pin.check('4829').ok).toBe(true);
    pin.check('1111'); pin.check('2222');
    const third = pin.check('3333');
    expect(third).toMatchObject({ ok: false, locked: true });
    expect(locks).toHaveLength(1);
    expect(pin.check('4829')).toMatchObject({ ok: false, locked: true });
    advance(15 * 60_000);
    expect(pin.check('4829').ok).toBe(true);
  });

  it('is never ok when no PIN is set', () => {
    const { pin } = make();
    expect(pin.check('1234').ok).toBe(false);
  });

  it('keeps the PIN input setting, voice only by default', () => {
    const { pin, file } = make();
    expect(pin.getSettings()).toEqual({ pinInput: 'voice' });
    pin.setSettings({ pinInput: 'voice-or-typed' });
    expect(new RemotePin({ file }).getSettings()).toEqual({ pinInput: 'voice-or-typed' });
    expect(() => pin.setSettings({ pinInput: 'smoke-signals' })).toThrow();
  });
});
