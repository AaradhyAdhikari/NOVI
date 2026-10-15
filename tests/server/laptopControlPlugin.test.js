import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createLaptopControlPlugin } from '../../plugins/laptop-control/index.js';

const NOVI = { id: 1, title: 'NOVI — Personal AI Companion - Google Chrome', process: 'chrome' };
const WA = { id: 2, title: 'WhatsApp', process: 'WhatsApp' };
const C1 = { id: 3, title: 'Gmail - Google Chrome', process: 'chrome' };
const C2 = { id: 4, title: 'YouTube - Google Chrome', process: 'chrome' };
const C3 = { id: 5, title: 'Docs - Google Chrome', process: 'chrome' };

function setup({ answers = {}, platform = 'win32', windows = [NOVI, WA, C1, C2, C3], clip = 'hello there friend' } = {}) {
  const calls = [];
  const worker = {
    async run(cmd, args = {}) {
      calls.push([cmd, args]);
      if (answers[cmd]) return answers[cmd](args);
      if (cmd === 'windows') return { windows };
      if (cmd === 'volume') return { level: args.level ?? 50 + (args.delta || 0), muted: Boolean(args.mute) };
      if (cmd === 'brightness') return { level: args.level ?? 60 + (args.delta || 0) };
      if (cmd === 'battery') return { percent: 72, charging: true };
      if (cmd === 'radio') return { on: args.on };
      if (cmd === 'clip-get') return { text: clip };
      return {};
    },
  };
  const host = new PluginHost({ runtime: {}, env: {}, logger: { warn() {} } });
  expect(host.register(createLaptopControlPlugin({ worker, platform, now: () => 1_000_000, pause: async () => {} }))).toBe(true);
  const tool = (name) => host.get(name);
  return { host, calls, tool };
}
const PHONE = { from: { deviceId: 'p1' } };
const LOSE = "You'll lose the connection to Novi until the laptop is back.";

describe('laptop control: sound, screen, media, battery', () => {
  it('volume and brightness: exact level or steps of 10, one short sentence back', async () => {
    const { tool, calls } = setup();
    expect((await tool('laptop_volume').run({ level: 30 })).note).toBe('Volume 30.');
    expect((await tool('laptop_volume').run({ change: 'up' })).note).toBe('Volume 60.');
    expect(calls.at(-1)).toEqual(['volume', { delta: 10 }]);
    expect((await tool('laptop_volume').run({ mute: true })).note).toBe('Muted.');
    expect((await tool('laptop_volume').run({ mute: false })).note).toBe('Unmuted.');
    expect((await tool('laptop_brightness').run({ change: 'down' })).note).toBe('Brightness 50.');
    expect(calls.at(-1)).toEqual(['brightness', { delta: -10 }]);
    expect(await tool('laptop_volume').gate({ level: 30 })).toEqual({});
  });

  it('media keys, battery and plain errors', async () => {
    const { tool, calls } = setup();
    expect((await tool('laptop_media').run({ key: 'pause' })).note).toBe('Paused.');
    expect(calls.at(-1)).toEqual(['media', { key: 'play' }]);
    expect((await tool('laptop_media').run({ key: 'next' })).note).toBe('Next.');
    expect((await tool('laptop_battery').run({})).note).toBe('72%, charging.');
    const drain = setup({ answers: { battery: () => ({ percent: 40, charging: false, minutesLeft: 100 }) } });
    expect((await drain.tool('laptop_battery').run({})).note).toBe('40%, about 1 h 40 min left.');
    const none = setup({ answers: { battery: () => ({ none: true }) } });
    expect((await none.tool('laptop_battery').run({})).note).toBe("This laptop doesn't report a battery.");
    const dark = setup({ answers: { brightness: () => { throw new Error('no-brightness'); } } });
    expect((await dark.tool('laptop_brightness').run({ level: 50 })).error).toBe("I can't change this screen's brightness.");
  });

  it('off Windows, or when the helper hangs, says so honestly', async () => {
    const off = setup({ answers: { volume: () => { throw new Error('not-windows'); } }, platform: 'linux' });
    expect((await off.tool('laptop_volume').run({ level: 10 })).error).toBe('Laptop controls work only on Windows.');
    const hung = setup({ answers: { battery: () => { throw new Error('timeout'); } } });
    expect((await hung.tool('laptop_battery').run({})).error).toBe("I couldn't reach the laptop controls.");
  });
});

describe('laptop control: anything that turns something off asks first', () => {
  it('Wi-Fi / Bluetooth off ask (never "always allow"); on runs at once', async () => {
    const { tool } = setup();
    const gate = await tool('laptop_radio').gate({ kind: 'wifi', on: false });
    expect(gate.approval).toMatchObject({ title: 'Turn Wi-Fi off?', tier: 'medium', category: 'laptop', grantable: false });
    expect((await tool('laptop_radio').gate({ kind: 'bluetooth', on: false }, PHONE)).approval.title).toBe(`Turn Bluetooth off? ${LOSE}`);
    expect(await tool('laptop_radio').gate({ kind: 'wifi', on: true })).toEqual({});
    expect((await tool('laptop_radio').run({ kind: 'wifi', on: false })).note).toBe('Wi-Fi is off.');
  });

  it('power: lock, sleep, shut down, restart, sign out ask; the phone hears the warning; cancel never asks', async () => {
    const { tool, calls } = setup();
    const title = async (args, ctx) => (await tool('laptop_power').gate(args, ctx)).approval?.title;
    expect(await title({ action: 'lock' })).toBe('Lock the laptop?');
    expect(await title({ action: 'lock' }, PHONE)).toBe('Lock the laptop?');
    expect(await title({ action: 'sleep' }, PHONE)).toBe(`Put the laptop to sleep? ${LOSE}`);
    expect(await title({ action: 'shutdown' })).toBe('Shut down the laptop?');
    expect(await title({ action: 'shutdown' }, PHONE)).toBe(`Shut down the laptop? ${LOSE}`);
    expect(await title({ action: 'restart' }, PHONE)).toBe(`Restart the laptop? ${LOSE}`);
    expect(await title({ action: 'signout' })).toBe('Sign out?');
    expect(await tool('laptop_power').gate({ action: 'cancel' })).toEqual({});
    const out = await tool('laptop_power').run({ action: 'shutdown' });
    expect(out).toMatchObject({ note: 'Shutting down in 15 seconds. Say cancel to stop.', countdownUntil: 1_015_000 });
    expect(calls.at(-1)).toEqual(['power', { action: 'shutdown' }]);
    expect((await tool('laptop_power').run({ action: 'restart' })).note).toBe('Restarting in 15 seconds. Say cancel to stop.');
    expect((await tool('laptop_power').run({ action: 'cancel' })).note).toBe('Okay, cancelled.');
    expect(calls.at(-1)).toEqual(['power-cancel', {}]);
    expect((await tool('laptop_power').run({ action: 'lock' })).note).toBe('Locked.');
  });
});

describe('laptop control: windows', () => {
  it('switch / minimize / maximize the front-most match without asking', async () => {
    const { tool, calls } = setup();
    expect(await tool('laptop_window').gate({ app: 'chrome', do: 'focus' })).toEqual({});
    expect((await tool('laptop_window').run({ app: 'chrome', do: 'focus' })).note).toBe('Switched to Chrome.');
    expect(calls.at(-1)).toEqual(['window', { id: 3, do: 'focus' }]);
    expect((await tool('laptop_window').run({ app: 'whatsapp', do: 'minimize' })).note).toBe('Minimized WhatsApp.');
    expect((await tool('laptop_window').run({ app: 'zoom', do: 'focus' })).error).toBe("I don't see a window for zoom.");
  });

  it('closing asks; "all" counts the windows and closes each; nothing to close asks nothing', async () => {
    const { tool, calls } = setup();
    expect((await tool('laptop_window').gate({ app: 'chrome', do: 'close' })).approval.title).toBe('Close Chrome?');
    expect((await tool('laptop_window').gate({ app: 'chrome', do: 'close', all: true })).approval.title).toBe('Close all 3 Chrome windows?');
    expect(await tool('laptop_window').gate({ app: 'zoom', do: 'close', all: true })).toEqual({});
    expect((await tool('laptop_window').run({ app: 'chrome', do: 'close', all: true })).note).toBe('Closed 3 Chrome windows.');
    expect(calls.filter(([c, a]) => c === 'window' && a.do === 'close').map(([, a]) => a.id)).toEqual([3, 4, 5]);
    expect((await tool('laptop_window').run({ app: 'novi', do: 'close' })).error).toBe("I don't see a window for novi.");
  });
});

describe('laptop control: clipboard', () => {
  it('reads aloud (private), but never a password or code', async () => {
    const { tool } = setup();
    const res = await tool('laptop_clipboard').run({ do: 'read' });
    expect(res).toMatchObject({ text: 'hello there friend', sensitive: true });
    const secret = setup({ clip: 'password: hunter2' });
    const out = await secret.tool('laptop_clipboard').run({ do: 'read' });
    expect(out.note).toBe("That looks like a password, I won't read it out.");
    expect(out.text).toBeUndefined();
    const empty = setup({ clip: '' });
    expect((await empty.tool('laptop_clipboard').run({ do: 'read' })).note).toBe("There's no text on the clipboard.");
  });

  it('copy this = Ctrl+C in the window you were working in; copy words sets them', async () => {
    const { tool, calls } = setup({ clip: 'the quick brown fox jumps over the lazy dog again' });
    const out = await tool('laptop_clipboard').run({ do: 'copy' });
    expect(calls.slice(-4)).toEqual([['windows', {}], ['window', { id: 2, do: 'focus' }], ['keys', { combo: 'copy' }], ['clip-get', {}]]);
    expect(out.note).toBe('Copied: the quick brown fox jumps over the lazy…');
    expect((await tool('laptop_clipboard').run({ do: 'set', text: 'hello world' })).note).toBe('Copied.');
    expect(calls.at(-1)).toEqual(['clip-set', { text: 'hello world' }]);
  });

  it('paste into an app: focus + Ctrl+V, never Enter', async () => {
    const { tool, calls } = setup();
    expect(await tool('laptop_clipboard').gate({ do: 'paste', app: 'whatsapp' })).toEqual({});
    expect((await tool('laptop_clipboard').run({ do: 'paste', app: 'whatsapp' })).note).toBe("Pasted into WhatsApp. I didn't send it.");
    expect(calls.slice(-2)).toEqual([['window', { id: 2, do: 'focus' }], ['keys', { combo: 'paste' }]]);
    expect(calls.filter(([c, a]) => c === 'keys' && !['copy', 'paste'].includes(a.combo))).toEqual([]);
    expect((await tool('laptop_clipboard').run({ do: 'paste', app: 'zoom' })).error).toBe("I don't see a window for zoom.");
  });
});
