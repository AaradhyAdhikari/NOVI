import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuiet, quietCommand } from '../../server/quiet.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-q-')), 'quiet.json');

describe('quiet mode', () => {
  it('on, off, for a while, and it survives a restart', () => {
    let t = 1_000_000;
    const f = file();
    const q = createQuiet({ file: f, now: () => t });
    expect(q.isOn()).toBe(false);
    q.on();
    expect(q.state()).toEqual({ on: true, until: null });
    expect(createQuiet({ file: f, now: () => t }).isOn()).toBe(true);
    q.off();
    expect(q.isOn()).toBe(false);
    q.on(30);
    expect(q.state()).toEqual({ on: true, until: new Date(t + 30 * 60_000).toISOString() });
    t += 31 * 60_000;
    expect(q.isOn()).toBe(false);
  });

  it('understands the ways it is asked for (not bare "mute": that is the laptop volume)', () => {
    for (const t of ['be quiet', 'Novi, quiet', 'quiet mode', 'quiet mode on', 'chup raho', 'stay quiet', "don't talk", 'silent mode', 'mute yourself'])
      expect(quietCommand(t), t).toEqual({ quiet: true, minutes: null });
    expect(quietCommand('quiet for 30 minutes')).toEqual({ quiet: true, minutes: 30 });
    expect(quietCommand('be quiet for an hour')).toEqual({ quiet: true, minutes: 60 });
    expect(quietCommand('quiet for half an hour')).toEqual({ quiet: true, minutes: 30 });
    for (const t of ['talk again', 'you can talk now', 'quiet mode off', 'bol sakti ho', 'unmute yourself', 'stop being quiet'])
      expect(quietCommand(t), t).toEqual({ quiet: false });
    for (const t of ['mute', 'unmute', 'be quiet about it later', 'what is quiet mode']) expect(quietCommand(t), t).toBe(null);
  });
});
