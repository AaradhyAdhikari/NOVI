import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createLocalSpeaker } from '../../server/voice/localSpeaker.js';

describe('laptop speaker (Windows voice)', () => {
  it('speaks through PowerShell with the text in an env var, never in the command line', async () => {
    const calls = [];
    const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); const c = new EventEmitter(); setTimeout(() => c.emit('exit', 0)); return c; };
    const speak = createLocalSpeaker({ platform: 'win32', run });
    await speak('Hello "; Remove-Item C:\ -Recurse #');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('powershell.exe');
    expect(calls[0].args.join(' ')).not.toContain('Remove-Item');
    expect(calls[0].opts.env.NOVI_SAY_TEXT).toBe('Hello "; Remove-Item C:\ -Recurse #');
  });

  it('says one line at a time', async () => {
    const order = [];
    const run = (cmd, args, opts) => { order.push(`start ${opts.env.NOVI_SAY_TEXT}`); const c = new EventEmitter(); setTimeout(() => { order.push(`end ${opts.env.NOVI_SAY_TEXT}`); c.emit('exit', 0); }, 5); return c; };
    const speak = createLocalSpeaker({ platform: 'win32', run });
    speak('one');
    await speak('two');
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two']);
  });

  it('is unavailable off Windows', () => {
    expect(createLocalSpeaker({ platform: 'linux' })).toBeNull();
  });
});
