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

  it('plays natural Edge speech when available, the Windows voice otherwise', async () => {
    const { run, spawned } = fakeVoice();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-say-'));
    let fail = false;
    const synth = async (text) => { if (fail) throw new Error('offline'); return Buffer.from(`MP3:${text}`); };
    const speak = createLocalSpeaker({ platform: 'win32', run, synth, tmpDir });
    await speak('Good morning');
    fail = true;
    await speak('Fallback please');
    const [first, second] = spawned[0].child.lines;
    expect(first).toMatch(/^PLAY:.*\.mp3$/);
    expect(fs.existsSync(first.slice(5))).toBe(false); // temp file removed after playing
    expect(second).toBe('Fallback please');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is unavailable off Windows', () => {
    expect(createLocalSpeaker({ platform: 'linux' })).toBeNull();
  });
});

describe('stopping the laptop voice mid-reply ("Hey Novi" interrupt)', () => {
  it('kills the playing reply, drops queued lines, and has a fresh voice ready', async () => {
    const { run, spawned } = fakeVoice({ delay: 1000 });
    const speak = createLocalSpeaker({ platform: 'win32', run });
    const first = speak('a long reply');
    const second = speak('queued line');
    await new Promise((r) => setTimeout(r, 5));
    speak.stop();
    await Promise.all([first, second]);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].child.lines).toEqual(['a long reply']);
    expect(spawned[1].child.lines).toEqual([]);
    await speak('next reply');
    expect(spawned).toHaveLength(2);
    expect(spawned[1].child.lines).toEqual(['next reply']);
  }, 3000);

  it('is harmless when nothing is playing, even twice', async () => {
    const { run, spawned } = fakeVoice();
    const speak = createLocalSpeaker({ platform: 'win32', run });
    speak.stop();
    speak.stop();
    expect(spawned.length).toBeLessThanOrEqual(1);
    await speak('hello');
    expect(spawned.length).toBeLessThanOrEqual(1);
    expect(spawned.at(-1).child.lines).toEqual(['hello']);
  });
});
