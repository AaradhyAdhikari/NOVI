import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createLocalSpeaker } from '../../server/voice/localSpeaker.js';

// Fake PowerShell voice process: answers "done" after each line it's given.
function fakeVoice({ delay = 1 } = {}) {
  const spawned = [];
  const run = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.lines = [];
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin = {
      write(chunk) {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          child.lines.push(line);
          setTimeout(() => child.stdout.emit('data', 'done\n'), delay);
        }
        return true;
      },
    };
    child.kill = () => child.emit('exit', 0);
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  return { run, spawned };
}

describe('laptop speaker (Windows voice)', () => {
  it('starts one voice process and keeps it for every line (no 2.5 s start-up each time)', async () => {
    const { run, spawned } = fakeVoice();
    const speak = createLocalSpeaker({ platform: 'win32', run });
    await speak('one');
    await speak('two');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].child.lines).toEqual(['one', 'two']);
  });

  it('sends text as data on stdin, never in the command line', async () => {
    const { run, spawned } = fakeVoice();
    const speak = createLocalSpeaker({ platform: 'win32', run });
    await speak('Hello "; Remove-Item C:\\ -Recurse #');
    expect(spawned[0].cmd).toBe('powershell.exe');
    expect(spawned[0].args.join(' ')).not.toContain('Remove-Item');
    expect(spawned[0].child.lines).toEqual(['Hello "; Remove-Item C:\\ -Recurse #']);
  });

  it('flattens line breaks so one reply is one line', async () => {
    const { run, spawned } = fakeVoice();
    await createLocalSpeaker({ platform: 'win32', run })('Line one.\nLine two.');
    expect(spawned[0].child.lines).toEqual(['Line one. Line two.']);
  });

  it('says one line at a time, in order', async () => {
    const { run } = fakeVoice({ delay: 5 });
    const speak = createLocalSpeaker({ platform: 'win32', run });
    const order = [];
    speak('one').then(() => order.push('one'));
    await speak('two').then(() => order.push('two'));
    expect(order).toEqual(['one', 'two']);
  });

  it('starts a fresh voice process if the old one died', async () => {
    const { run, spawned } = fakeVoice();
    const speak = createLocalSpeaker({ platform: 'win32', run });
    await speak('one');
    spawned[0].child.emit('exit', 1);
    await speak('two');
    expect(spawned).toHaveLength(2);
    expect(spawned[1].child.lines).toEqual(['two']);
  });

  it('is unavailable off Windows', () => {
    expect(createLocalSpeaker({ platform: 'linux' })).toBeNull();
  });
});
