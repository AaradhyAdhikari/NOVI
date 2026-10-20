import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameCommand } from '../../server/brain/sameCommand.js';
import { Memory } from '../../server/memory.js';

// "NOVI CONTEXT and NOVI are the same" by voice (user, 2026-10-20), without the AI.
describe('sameCommand', () => {
  it('"X and Y are the same (thing/project)", "X is the same as Y", Hinglish', () => {
    expect(sameCommand('NOVI CONTEXT and NOVI are the same')).toEqual({ tool: 'same_set', args: { a: 'NOVI CONTEXT', b: 'NOVI', same: true } });
    expect(sameCommand('okay Novi, medikiiosk and Medikiosk are the same project.')).toEqual({ tool: 'same_set', args: { a: 'medikiiosk', b: 'Medikiosk', same: true } });
    expect(sameCommand('FlexR is the same as Flexr app')).toEqual({ tool: 'same_set', args: { a: 'FlexR', b: 'Flexr app', same: true } });
    expect(sameCommand('NOVI aur NOVI CONTEXT ek hi hai')).toEqual({ tool: 'same_set', args: { a: 'NOVI', b: 'NOVI CONTEXT', same: true } });
  });

  it('"X and Y are different / not the same", "alag hai"', () => {
    expect(sameCommand('Signsync and Signsyncer are different')).toEqual({ tool: 'same_set', args: { a: 'Signsync', b: 'Signsyncer', same: false } });
    expect(sameCommand("Portfolio and Portfolio 2 aren't the same thing")).toEqual({ tool: 'same_set', args: { a: 'Portfolio', b: 'Portfolio 2', same: false } });
    expect(sameCommand('NOVI aur novi-playground alag hai')).toEqual({ tool: 'same_set', args: { a: 'NOVI', b: 'novi-playground', same: false } });
  });

  it('leaves other sentences alone', () => {
    for (const t of ['is it the same as yesterday', 'they are the same', 'play the same song again', 'what is the difference between C and C++']) expect(sameCommand(t), t).toBe(null);
  });
});

describe('Memory.findProject by another name', () => {
  it('finds the project under any name in its "Same things" group', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-alias-'));
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-alias-folder-'));
    const memory = new Memory(path.join(dir, 'memory.json'));
    memory.rememberProject('NOVI CONTEXT', folder);
    expect(memory.findProject('medikiosk')).toBe(null);
    memory.aliasesOf = (name) => ({ novi: ['NOVI CONTEXT'], medikiosk: ['medikiiosk'] }[name.toLowerCase()] || []);
    expect(memory.findProject('Novi')).toMatchObject({ name: 'novi context', path: folder });
    expect(memory.findProject('medikiosk')).toBe(null); // its other name has no folder either
  });
});
