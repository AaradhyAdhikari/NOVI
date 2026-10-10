import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../../server/memory.js';
import { rememberOwnProject } from '../../server/ownProject.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-own-'));

describe('Novi knows its own folder as the project "novi"', () => {
  it('remembers it once, so "fix the login bug in Novi" works without asking for the folder', () => {
    const dir = tmp();
    const memory = new Memory(path.join(dir, 'm.json'));
    const own = fs.mkdirSync(path.join(dir, 'NOVI CONTEXT'), { recursive: true }) || path.join(dir, 'NOVI CONTEXT');
    expect(rememberOwnProject(memory, own)).toBe(true);
    expect(memory.findProject('Novi')).toMatchObject({ name: 'novi', path: path.resolve(own) });
    expect(rememberOwnProject(memory, own)).toBe(false);
  });

  it('never overwrites a "novi" project the user saved somewhere else', () => {
    const dir = tmp();
    const memory = new Memory(path.join(dir, 'm.json'));
    const elsewhere = fs.mkdtempSync(path.join(dir, 'elsewhere-'));
    memory.rememberProject('novi', elsewhere);
    expect(rememberOwnProject(memory, dir)).toBe(false);
    expect(memory.findProject('novi').path).toBe(path.resolve(elsewhere));
  });

  it('a project merely containing "novi" in its name does not block it, and a bad folder never crashes startup', () => {
    const dir = tmp();
    const memory = new Memory(path.join(dir, 'm.json'));
    memory.rememberProject('novi website', fs.mkdtempSync(path.join(dir, 'site-')));
    expect(rememberOwnProject(memory, dir)).toBe(true);
    const other = new Memory(path.join(tmp(), 'm.json'));
    expect(rememberOwnProject(other, path.join(dir, 'does-not-exist'))).toBe(false);
  });
});
