import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createLaptopControlPlugin } from '../../plugins/laptop-control/index.js';

const NOVI = { id: 1, title: 'NOVI — Personal AI Companion - Google Chrome', process: 'chrome' };
const WA = { id: 2, title: 'WhatsApp', process: 'WhatsApp' };
const C1 = { id: 3, title: 'Gmail - Google Chrome', process: 'chrome' };
const C2 = { id: 4, title: 'YouTube - Google Chrome', process: 'chrome' };
const C3 = { id: 5, title: 'Docs - Google Chrome', process: 'chrome' };

function setup({ answers = {}, platform = 'win32', windows = [NOVI, WA, C1, C2, C3], clip = 'hello there friend', video } = {}) {
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
  const host = new PluginHost({ runtime: video ? { browserVideo: video } : {}, env: {}, logger: { warn() {} } });
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

  it('"this" is the window the user is working in, never Novi', async () => {
    const { tool, calls } = setup();
    const out = await tool('laptop_window').run({ app: 'this', do: 'minimize' });
    expect(out.error).toBeUndefined();
    expect(calls.at(-1)[1].do).toBe('minimize');
    expect(out.note).not.toMatch(/novi/i);
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

  // Dictation (2026-10-18): the words go into the app in front, and what was copied before comes back.
  it('type = the words pasted into the app in front, the old clipboard put back, never Enter', async () => {
    const { tool, calls } = setup({ clip: 'my old copy' });
    expect(await tool('laptop_clipboard').gate({ do: 'type', text: 'see you at 5' })).toEqual({});
    expect((await tool('laptop_clipboard').run({ do: 'type', text: 'see you at 5' })).note).toBe('Typed into WhatsApp.');
    expect(calls).toEqual([['clip-get', {}], ['clip-set', { text: 'see you at 5' }], ['windows', {}], ['window', { id: 2, do: 'focus' }], ['keys', { combo: 'paste' }], ['clip-set', { text: 'my old copy' }]]);
    expect((await tool('laptop_clipboard').run({ do: 'type', text: '  ' })).error).toBe("There's nothing to type.");
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

// Live 2026-10-22 from the phone: "Skip 10 minutes from the video." → "I'm not able to jump forward…".
// Media keys can't seek; Windows' media controls can (YouTube in Chrome, Spotify, most players).
describe('skip forward / back / jump in a video or song', () => {
  it('moves what is playing and says where it is now', async () => {
    const { tool, calls } = setup({ answers: { seek: (a) => ({ moved: true, from: 252, to: 252 + (a.by ?? 0), end: 6272, title: 'PARTY ANIMALS WITH S8UL', app: 'Chrome' }) } });
    expect((await tool('laptop_seek').run({ by: 600 })).note).toBe('Skipped ahead 10 min — now at 14:12 of 1:44:32 (PARTY ANIMALS WITH S8UL).');
    expect(calls.at(-1)).toEqual(['seek', { by: 600 }]);
    expect((await tool('laptop_seek').run({ by: -30 })).note).toMatch(/^Went back 30 s — now at 3:42 of 1:44:32/);
    const to = setup({ answers: { seek: () => ({ moved: true, from: 10, to: 330, end: 400, title: 'Song', app: 'Spotify.exe' }) } });
    expect((await to.tool('laptop_seek').run({ to: 330 })).note).toBe('Jumped to 5:30 of 6:40 (Song).');
  });

  it('nothing playing, a player that cannot seek, a player that ignored it — said plainly', async () => {
    expect((await setup({ answers: { seek: () => ({ none: true }) } }).tool('laptop_seek').run({ by: 60 })).error).toBe('Nothing is playing on the laptop.');
    expect((await setup({ answers: { seek: () => ({ cantSeek: true, app: 'Spotify.exe' }) } }).tool('laptop_seek').run({ by: 60 })).error).toBe("Spotify doesn't let me jump in what's playing.");
    expect((await setup({ answers: { seek: () => ({ moved: false, app: 'Chrome' }) } }).tool('laptop_seek').run({ by: 60 })).error).toBe("Chrome didn't move. Try again in a moment.");
    expect((await setup().tool('laptop_seek').run({})).error).toMatch(/how far/i);
  });
});

describe('hiding Novi\'s work window', () => {
  it('runtime.hideWindows asks the helper to hide windows whose title starts with the prefix', async () => {
    const host = new PluginHost({ runtime: {}, logger: { warn() {} } });
    const calls = [];
    host.register(createLaptopControlPlugin({ platform: 'win32', worker: { run: async (cmd, args) => { calls.push([cmd, args]); return { hidden: 1 }; } } }));
    expect(await host.runtime.hideWindows('Novi work - ')).toEqual({ hidden: 1 });
    expect(calls).toEqual([['hide', { prefix: 'Novi work - ' }]]);
    await expect(host.runtime.hideWindows('')).resolves.toEqual({ hidden: 0 }); // never "everything"
  });
});

describe('the page open in the front browser', () => {
  it('laptop_current_link: its address (https added), read-only', async () => {
    const { tool } = setup({ answers: { link: () => ({ url: 'kick.com/snaxgaming', title: 'snaxgaming Live Stream - Watch Live on KICK', browser: 'brave' }) } });
    expect(await tool('laptop_current_link').gate({})).toEqual({});
    const out = await tool('laptop_current_link').run({});
    expect(out).toMatchObject({ url: 'https://kick.com/snaxgaming', browser: 'Brave' });
    expect(out.note).toBe('The page open in Brave: https://kick.com/snaxgaming');
    expect((await setup({ answers: { link: () => ({ none: true }) } }).tool('laptop_current_link').run({})).error).toBe('No browser window is open on the laptop.');
  });
});

describe('the tab open in the front browser', () => {
  it('laptop_tab closes it without asking and says how to bring it back; reopen too', async () => {
    const { tool, calls } = setup({ answers: { tab: () => ({ win: 42, title: 'snaxgaming Live Stream - Watch Live on KICK - Brave', browser: 'brave' }) } });
    expect(await tool('laptop_tab').gate({ do: 'close' })).toEqual({});
    const out = await tool('laptop_tab').run({ do: 'close' });
    expect(out.note).toBe('Closed the "snaxgaming Live Stream - Watch Live on KICK" tab in Brave. Say "reopen the tab" to bring it back.');
    expect((await tool('laptop_tab').run({ do: 'reopen' })).note).toBe('Opened the last closed tab again in Brave.');
    // reopened in the window Novi closed it in (live: focus moved to another browser and reopened there)
    expect(calls.filter((c) => c[0] === 'tab').map((c) => c[1])).toEqual([{ do: 'close' }, { do: 'reopen', win: 42 }]);
    expect((await setup({ answers: { tab: () => ({ none: true }) } }).tool('laptop_tab').run({ do: 'close' })).error).toBe('No browser window is open on the laptop.');
  });
});

// Live 2026-11-04: Chrome wasn't in Windows' media list, so pause/seek hit a paused Spotify and started it.
describe('a video in Chrome comes first', () => {
  const seen = (out) => { const asked = []; return { asked, video: async (a) => { asked.push(a); return out; } }; };

  it('skips and jumps in the Chrome video, not in Spotify', async () => {
    const v = seen({ done: true, to: 160, end: 3600, title: '1 A.M Study Session' });
    const s = setup({ video: v.video, answers: { seek: () => { throw new Error('Spotify was moved'); } } });
    expect((await s.tool('laptop_seek').run({ by: 10 })).note).toBe('Skipped ahead 10 s — now at 2:40 of 1:00:00 (1 A.M Study Session).');
    expect(v.asked[0]).toEqual({ do: 'seek', by: 10 });
    expect((await s.tool('laptop_seek').run({ to: 160 })).note).toBe('Jumped to 2:40 of 1:00:00 (1 A.M Study Session).');
  });

  it('pauses the Chrome video without touching the media key', async () => {
    const v = seen({ done: true });
    const s = setup({ video: v.video, answers: { media: () => { throw new Error('key pressed'); }, transport: () => { throw new Error('windows used'); } } });
    expect((await s.tool('laptop_media').run({ key: 'pause' })).note).toBe('Paused.');
    expect(v.asked).toEqual([{ do: 'pause' }]);
  });

  it('no video: Windows media controls, and the extension failing changes nothing', async () => {
    const s = setup({ video: async () => { throw new Error('unknown command'); }, answers: { seek: () => ({ moved: true, to: 20, end: 100, title: 'Song' }) } });
    expect((await s.tool('laptop_seek').run({ by: 10 })).note).toMatch(/Song/);
  });

  it('"pause" never starts something that was stopped', async () => {
    const s = setup({ video: async () => ({ none: true }), answers: { media: () => { throw new Error('toggled'); }, transport: () => ({ sessions: 1, changed: 0 }) } });
    expect((await s.tool('laptop_media').run({ key: 'pause' })).note).toBe('Nothing is playing.');
  });

  it('"play" never stops what is already playing', async () => {
    const s = setup({ video: async () => ({ none: true }), answers: { media: () => { throw new Error('toggled'); }, transport: () => ({ sessions: 1, changed: 0 }) } });
    expect((await s.tool('laptop_media').run({ key: 'play' })).note).toBe('Playing.');
  });
});

// Live 2026-11-04: the video was in a Chrome profile without the extension, and Windows' list only had Spotify.
describe('YouTube in a browser the extension is not in', () => {
  const YT = { id: 7, title: '(2256) 1 A.M Study Session - YouTube - Google Chrome', process: 'chrome' };
  const LINK = { url: 'youtube.com/watch?v=abc&list=x', browser: 'chrome' };
  const never = () => { throw new Error('Spotify was touched'); };
  const front = (answers = {}) => setup({ video: async () => ({ none: true }), windows: [NOVI, YT, WA], answers: { seek: never, media: never, link: () => LINK, ...answers } });
  const pressed = (s) => s.calls.filter(([c]) => c === 'ytkey').map(([, a]) => a);

  it('skips with its own keys: 10 s = L, 5 s = right arrow, back = J and left arrow', async () => {
    const s = front();
    expect((await s.tool('laptop_seek').run({ by: 25 })).note).toBe('Skipped ahead 25 s.');
    expect(pressed(s)[0]).toEqual({ id: 7, keys: [0x4c, 0x4c, 0x27] });
    expect((await s.tool('laptop_seek').run({ by: -15 })).note).toBe('Went back 15 s.');
    expect(pressed(s)[1]).toEqual({ id: 7, keys: [0x4a, 0x25] });
  });

  it('the browser refusing to come forward: says so, and no key goes anywhere else', async () => {
    const s = front({ ytkey: () => ({ notFront: true }), address: () => ({ notFront: true }) });
    expect((await s.tool('laptop_seek').run({ by: 10 })).error).toMatch(/front/);
    expect((await s.tool('laptop_media').run({ key: 'pause' })).error).toMatch(/front/);
    expect((await s.tool('laptop_seek').run({ to: 150 })).error).toMatch(/front/);
    expect(s.calls.at(-1)[0]).toBe('clip-back');
    expect(s.calls.find(([c]) => c === 'address')[1].id).toBe(7);
  });

  it('a very long skip asks for the exact time instead of a hundred key presses', async () => {
    const s = front();
    expect((await s.tool('laptop_seek').run({ by: 3600 })).error).toMatch(/exact time/);
    expect(pressed(s)).toEqual([]);
  });

  it('an exact time goes in through the link, and the old copy comes back', async () => {
    const s = front();
    expect((await s.tool('laptop_seek').run({ to: 150 })).note).toBe('Jumped to 2:30.');
    expect(s.calls.find(([c]) => c === 'address')[1].url).toBe('https://youtube.com/watch?v=abc&list=x&t=150s');
    expect(s.calls.map(([c]) => c).slice(-3)).toEqual(['clip-keep', 'address', 'clip-back']); // the old copy only after the page took it
  });

  it('pause and play press K once, and saying pause twice does not start it again', async () => {
    const s = front();
    expect((await s.tool('laptop_media').run({ key: 'pause' })).note).toBe('Paused.');
    expect((await s.tool('laptop_media').run({ key: 'pause' })).note).toBe('Already paused.');
    expect(pressed(s)).toEqual([{ id: 7, keys: [0x4b] }]);
    expect((await s.tool('laptop_media').run({ key: 'play' })).note).toBe('Playing.');
    expect(pressed(s).length).toBe(2);
  });

  it('music playing and YouTube only open behind: the music is what you mean', async () => {
    const s = setup({ video: async () => ({ none: true }), windows: [NOVI, WA, YT], answers: { transport: (a) => ({ sessions: 1, playing: 1, changed: a.do === 'pause' ? 1 : 0 }) } });
    expect((await s.tool('laptop_media').run({ key: 'pause' })).note).toBe('Paused.');
    expect(pressed(s)).toEqual([]);
  });
});

describe('pasting into one exact window', () => {
  it('goes only to that window, and says so when it is gone or will not come forward', async () => {
    const s = setup({ answers: { 'paste-to': (a) => (a.id === 3 ? {} : { notFront: true }) } });
    const run = (args) => s.tool('laptop_clipboard').run({ do: 'type', text: 'hi', ...args });
    expect((await run({ id: 3 })).error).toBeUndefined();
    expect(s.calls.some(([c]) => c === 'keys')).toBe(false);
    expect((await run({ id: 4 })).error).toMatch(/front/);
    expect((await run({ id: 999 })).error).toMatch(/closed/);
    expect(s.calls.at(-1)).toEqual(['clip-set', { text: 'hello there friend' }]);
  });

  it('"copy" says which window the words came from', async () => {
    expect((await setup().tool('laptop_clipboard').run({ do: 'copy' })).window).toBeTruthy();
  });
});

describe('the video alone', () => {
  const YT = { id: 7, title: 'Lofi mix - YouTube - Google Chrome', process: 'chrome' };
  const KICK = { id: 8, title: 'Neyoo_Gaming Live Stream - Watch Live on KICK - Brave', process: 'brave' };
  const never = () => { throw new Error('laptop sound touched'); };
  const pressed = (s) => s.calls.filter(([c]) => c === 'ytkey').map(([, a]) => a);

  it('asks the extension first', async () => {
    const asked = [];
    const s = setup({ video: async (a) => { asked.push(a); return { done: true }; }, answers: { volume: never } });
    expect((await s.tool('laptop_video_mute').run({ on: true })).note).toBe('Muted the video.');
    expect(asked).toEqual([{ do: 'mute', on: true }]);
  });

  it('else presses M on the site in front, once, never the laptop sound', async () => {
    const s = setup({ windows: [NOVI, KICK, YT], answers: { volume: never } });
    expect((await s.tool('laptop_video_mute').run({ on: true })).note).toBe('Muted the video.');
    expect(pressed(s)).toEqual([{ id: 8, keys: [0x4d] }]);
    expect((await s.tool('laptop_video_mute').run({ on: true })).note).toBe('The video is already muted.');
    expect(pressed(s).length).toBe(1);
    expect((await s.tool('laptop_video_mute').run({ on: false })).note).toBe('Unmuted the video.');
  });

  it('no video site open: says so plainly', async () => {
    expect((await setup({ windows: [NOVI, WA] }).tool('laptop_video_mute').run({ on: true })).error).toMatch(/video/);
  });
});

describe('selecting by voice', () => {
  it('selects in the app being worked in and says what', async () => {
    const s = setup({ windows: [NOVI, WA] });
    expect((await s.tool('laptop_select').run({ what: 'first', n: 3 })).note).toBe('Selected the first 3 lines.');
    expect(s.calls.at(-1)).toEqual(['select-keys', { id: 2, what: 'first', n: 3 }]);
    expect((await s.tool('laptop_select').run({ what: 'all' })).note).toBe('Selected everything.');
    expect((await s.tool('laptop_select').run({ what: 'line' })).note).toBe('Selected the line.');
  });
  it('a window that will not come forward gets nothing', async () => {
    const s = setup({ windows: [NOVI, WA], answers: { 'select-keys': () => ({ notFront: true }) } });
    expect((await s.tool('laptop_select').run({ what: 'all' })).error).toMatch(/front/);
  });
  it('after an edit the new words can stay selected', async () => {
    const s = setup({ answers: { 'paste-to': () => ({}) } });
    await s.tool('laptop_clipboard').run({ do: 'type', text: 'ab\ncd', id: 3, reselect: true });
    expect(s.calls.find(([c]) => c === 'paste-to')[1]).toEqual({ id: 3, back: 5 });
  });
});
