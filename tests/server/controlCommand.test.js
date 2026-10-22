import { describe, it, expect } from 'vitest';
import { controlCommand, isCancelWord } from '../../server/brain/controlCommand.js';

const T = (tool, args) => ({ tool, args });
const cases = [
  ['volume 40', T('laptop_volume', { level: 40 })],
  ['Set the volume to 40 percent.', T('laptop_volume', { level: 40 })],
  ['volume up', T('laptop_volume', { change: 'up' })],
  ['turn up the volume', T('laptop_volume', { change: 'up' })],
  ['louder', T('laptop_volume', { change: 'up' })],
  ['awaaz badhao', T('laptop_volume', { change: 'up' })],
  ['awaaz kam karo', T('laptop_volume', { change: 'down' })],
  ['quieter please', T('laptop_volume', { change: 'down' })],
  ['mute', T('laptop_volume', { mute: true })],
  ['unmute the laptop', T('laptop_volume', { mute: false })],
  ['brightness 70', T('laptop_brightness', { level: 70 })],
  ['brightness kam karo', T('laptop_brightness', { change: 'down' })],
  ['increase the brightness', T('laptop_brightness', { change: 'up' })],
  ['pause', T('laptop_media', { key: 'pause' })],
  ['play', T('laptop_media', { key: 'play' })],
  ['resume', T('laptop_media', { key: 'play' })],
  ['next song', T('laptop_media', { key: 'next' })],
  ['agla gaana', T('laptop_media', { key: 'next' })],
  ['previous song', T('laptop_media', { key: 'previous' })],
  ['how much battery', T('laptop_battery', {})],
  ['how much battery is left?', T('laptop_battery', {})],
  ['battery kitni hai', T('laptop_battery', {})],
  ['turn wifi off', T('laptop_radio', { kind: 'wifi', on: false })],
  ['turn off the wi-fi', T('laptop_radio', { kind: 'wifi', on: false })],
  ['wifi band karo', T('laptop_radio', { kind: 'wifi', on: false })],
  ['turn bluetooth on', T('laptop_radio', { kind: 'bluetooth', on: true })],
  ['bluetooth chalu karo', T('laptop_radio', { kind: 'bluetooth', on: true })],
  ['lock the laptop', T('laptop_power', { action: 'lock' })],
  ['lock my screen', T('laptop_power', { action: 'lock' })],
  ['put the laptop to sleep', T('laptop_power', { action: 'sleep' })],
  ['shut down', T('laptop_power', { action: 'shutdown' })],
  ['shutdown the laptop', T('laptop_power', { action: 'shutdown' })],
  ['restart the laptop', T('laptop_power', { action: 'restart' })],
  ['log out', T('laptop_power', { action: 'signout' })],
  ['cancel the shutdown', T('laptop_power', { action: 'cancel' })],
  ['switch to WhatsApp', T('laptop_window', { app: 'WhatsApp', do: 'focus' })],
  ['go to whatsapp', T('laptop_window', { app: 'whatsapp', do: 'focus' })],
  ['minimize chrome', T('laptop_window', { app: 'chrome', do: 'minimize' })],
  ['maximize VS Code', T('laptop_window', { app: 'VS Code', do: 'maximize' })],
  ['close chrome', T('laptop_window', { app: 'chrome', do: 'close' })],
  ['close all chrome windows', T('laptop_window', { app: 'chrome', do: 'close', all: true })],
  ['chrome band karo', T('laptop_window', { app: 'chrome', do: 'close' })],
  ['read what I copied', T('laptop_clipboard', { do: 'read' })],
  ["what's on my clipboard", T('laptop_clipboard', { do: 'read' })],
  ['kya copy kiya', T('laptop_clipboard', { do: 'read' })],
  ['copy this', T('laptop_clipboard', { do: 'copy' })],
  ['copy hello world', T('laptop_clipboard', { do: 'set', text: 'hello world' })],
  ['paste it into whatsapp', T('laptop_clipboard', { do: 'paste', app: 'whatsapp' })],
  ['Okay, paste it in WhatsApp', T('laptop_clipboard', { do: 'paste', app: 'WhatsApp' })],
];

describe('controlCommand: laptop controls without the AI', () => {
  it('understands everyday phrases (English + Hinglish)', () => {
    for (const [text, want] of cases) expect(controlCommand(text), text).toEqual(want);
  });

  it('"copy your answer" asks the agent for Novi\'s last reply', () => {
    expect(controlCommand('copy your answer')).toEqual({ tool: 'laptop_clipboard', args: { do: 'set' }, lastReply: true });
    expect(controlCommand('copy that answer')).toEqual({ tool: 'laptop_clipboard', args: { do: 'set' }, lastReply: true });
  });

  it('leaves other requests alone', () => {
    for (const t of ['play despacito on youtube', 'play despacito', 'open youtube', 'switch to novi', 'close it', 'close', 'stop',
      'search the web for volume', 'lock in the plan', 'what is the battery life of iPhone 18', 'copy', 'copy the code', 'copy my email address', 'copy the link']) {
      expect(controlCommand(t), t).toBe(null);
    }
  });

  it('isCancelWord: cancel / stop / ruko, not other cancels', () => {
    for (const t of ['cancel', 'Cancel.', 'stop', 'ruko', 'rok do', 'stop the shutdown', 'cancel the restart', 'mat karo']) expect(isCancelWord(t), t).toBe(true);
    for (const t of ['cancel my meeting', 'stop the music', 'hello']) expect(isCancelWord(t), t).toBe(false);
  });
});

describe('historyCommand: the command history by voice', () => {
  it('today\'s commands; other requests stay', async () => {
    const { historyCommand } = await import('../../server/brain/controlCommand.js');
    for (const t of ['what commands did you run today', 'What commands have you run?', 'show me the command history', 'aaj kaun se commands chalaye']) {
      expect(historyCommand(t), t).toEqual({ tool: 'commands_history', args: { today: true } });
    }
    for (const t of ['run a command', 'what did you do today', 'command prompt kholo']) expect(historyCommand(t), t).toBe(null);
  });
});

describe('diskCommand (free space without the AI, 2026-10-17)', () => {
  it('free space / storage questions → laptop_disk; cleaning up stays with the AI', async () => {
    const { diskCommand } = await import('../../server/brain/controlCommand.js');
    expect(diskCommand('Tell me how much free space is on my C drive.')).toEqual({ tool: 'laptop_disk', args: { drive: 'C' } });
    expect(diskCommand('how much space is left on D drive')).toEqual({ tool: 'laptop_disk', args: { drive: 'D' } });
    expect(diskCommand('how much storage is left on my laptop')).toEqual({ tool: 'laptop_disk', args: { drive: 'C' } });
    expect(diskCommand('free space on E:')).toEqual({ tool: 'laptop_disk', args: { drive: 'E' } });
    expect(diskCommand('C drive me kitni jagah bachi hai')).toEqual({ tool: 'laptop_disk', args: { drive: 'C' } });
    expect(diskCommand('free up space on my C drive')).toBeNull();
    expect(diskCommand('what is the weather')).toBeNull();
  });
});

describe('skip forward / back / jump by voice (no AI)', () => {
  const seek = (t) => { const c = controlCommand(t); return c?.tool === 'laptop_seek' ? c.args : c; };
  it('forward and back, minutes and seconds, words and numbers, English and Hinglish', () => {
    expect(seek('Skip 10 minutes from the video.')).toEqual({ by: 600 });
    expect(seek('skip ahead 30 seconds')).toEqual({ by: 30 });
    expect(seek('forward 2 minutes')).toEqual({ by: 120 });
    expect(seek('fast forward the song by a minute')).toEqual({ by: 60 });
    expect(seek('go back 10 seconds')).toEqual({ by: -10 });
    expect(seek('rewind five minutes')).toEqual({ by: -300 });
    expect(seek('skip back 1 minute 30 seconds')).toEqual({ by: -90 });
    expect(seek('10 minute aage karo')).toEqual({ by: 600 });
    expect(seek('video 30 second peeche karo')).toEqual({ by: -30 });
    expect(seek('jump to 5:30')).toEqual({ to: 330 });
    expect(seek('go to minute 12 in the video')).toEqual({ to: 720 });
    expect(seek('skip to 1:02:03')).toEqual({ to: 3723 });
  });
  it('plain skip / next still means the next song', () => {
    expect(controlCommand('skip')).toEqual({ tool: 'laptop_media', args: { key: 'next' } });
    expect(controlCommand('skip this song')).toEqual({ tool: 'laptop_media', args: { key: 'next' } });
  });
});

describe('skip words inside other requests are not a skip', () => {
  it('reminders, timers and "in N minutes" stay what they are', () => {
    for (const t of ['remind me to go back home in 10 minutes', 'set a timer for 10 minutes', 'forward this email to Isha in 5 minutes', 'skip the gym after 20 minutes']) {
      expect(controlCommand(t)?.tool).not.toBe('laptop_seek');
    }
  });
});

// Live 2026-10-22: "Show me the screenshot of my screen on laptop." → "Here's a screenshot of your laptop
// screen." with no screenshot taken (the AI only said it). Now it goes straight to screen_show.
describe('a screenshot of the laptop screen, without the AI', () => {
  it('the ways it is said', () => {
    for (const t of ['Show me the screenshot of my screen on laptop.', 'take a screenshot', 'send me a screenshot of my laptop screen', 'ss of my screen', 'show me my laptop screen', 'screen ka ss bhejo', "what's on my screen right now"]) {
      expect(controlCommand(t), t).toEqual({ tool: 'screen_show', args: {} });
    }
  });
  it('a project page / homepage picture stays with the preview', () => {
    expect(controlCommand('send me a screenshot of the homepage')).toBeNull();
    expect(controlCommand('screenshot of the work you are doing')).toBeNull();
  });
});
