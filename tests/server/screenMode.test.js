import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createScreenPlugin } from '../../plugins/screen/index.js';
import { parseScreenCommand, pickResult } from '../../plugins/screen/mode.js';
import { isScreenModeStart } from '../../server/brain/screenModeCommand.js';

const GOOGLE = {
  title: 'GitHub - Google Search - Google Chrome',
  items: [
    { type: 'Edit', name: 'Search', x: 400, y: 120 },
    { type: 'Hyperlink', name: 'Images', x: 300, y: 180 },
    { type: 'Hyperlink', name: 'Sign in', x: 1800, y: 60 },
    { type: 'Hyperlink', name: 'GitHub · Build and ship software on a single platform https://github.com', x: 500, y: 300 },
    { type: 'Hyperlink', name: 'Sign in to GitHub https://github.com › login', x: 500, y: 420 },
    { type: 'Hyperlink', name: 'GitHub - Wikipedia https://en.wikipedia.org › wiki › GitHub', x: 500, y: 560 },
    { type: 'Button', name: 'Blue send', x: 900, y: 900 },
    { type: 'Button', name: 'Delete repository', x: 900, y: 950 },
    { type: 'Button', name: 'Buy now', x: 900, y: 990 },
    { type: 'Button', name: 'Minimize', x: 1850, y: 10 },
  ],
};

function setup({ screen = GOOGLE, windows = ['Google Chrome', 'WhatsApp'], front = screen.title, found = { found: true, point: [500, 500] } } = {}) {
  const actions = [];
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-screenmode-'));
  const state = { front };
  const driver = {
    screenshot: async () => ({ png: Buffer.from('PNG'), width: 1000, height: 1000 }),
    window: async () => state.front,
    items: async () => screen,
    click: async (x, y) => actions.push(['click', x, y]),
    type: async (text) => actions.push(['type', text]),
    key: async (name) => actions.push(['key', name]),
    scroll: async (n) => actions.push(['scroll', n]),
    focus: async (app) => { actions.push(['focus', app]); state.front = app; return true; },
  };
  const callTool = async (name, params) => {
    calls.push([name, params]);
    if (name === 'laptop_window') {
      const open = params.app === 'this' || windows.some((w) => w.toLowerCase().includes(String(params.app).toLowerCase()));
      return open ? { note: `${params.do === 'minimize' ? 'Minimized' : params.do === 'maximize' ? 'Maximized' : 'Switched to'} ${params.app}.` } : { error: `I don't see a window for ${params.app}.`, notFound: true };
    }
    return { note: 'ok' };
  };
  const vision = async (_png, prompt) => (/JSON/.test(prompt) ? JSON.stringify(found) : 'A Google results page for GitHub.');
  const host = new PluginHost({ runtime: { vision, callTool, dataDir: dir }, env: {}, logger: { warn() {} } });
  expect(host.register(createScreenPlugin({ driver }))).toBe(true);
  const say = async (text) => host.get('screen_command').run({ text });
  return { host, actions, calls, dir, say, gate: (text, direct = true) => host.get('screen_command').gate({ text }, { direct }) };
}
const on = async (s) => { await s.say('start screen control'); return s; };

describe('screen mode: what the words mean', () => {
  it('reads the everyday commands', () => {
    expect(parseScreenCommand('Start screen control')).toEqual({ do: 'start' });
    expect(parseScreenCommand('stop screen control')).toEqual({ do: 'stop' });
    expect(parseScreenCommand('Stop.')).toEqual({ do: 'stop' });
    expect(parseScreenCommand('Open Chrome.')).toEqual({ do: 'open', app: 'Chrome' });
    expect(parseScreenCommand('Search for GitHub.')).toEqual({ do: 'search', query: 'GitHub' });
    expect(parseScreenCommand('Open the second result.')).toEqual({ do: 'result', n: 2 });
    expect(parseScreenCommand('Click login.')).toEqual({ do: 'click', target: 'login' });
    expect(parseScreenCommand('Click 3')).toEqual({ do: 'click', n: 3 });
    expect(parseScreenCommand('click option 3')).toEqual({ do: 'click', n: 3 });
    expect(parseScreenCommand('Type this in the search box: Novi AI.')).toEqual({ do: 'type', text: 'Novi AI', target: 'search box' });
    expect(parseScreenCommand('Type Novi AI')).toEqual({ do: 'type', text: 'Novi AI' });
    expect(parseScreenCommand('type hello in box 4')).toEqual({ do: 'type', text: 'hello', n: 4 });
    expect(parseScreenCommand('Press Enter.')).toEqual({ do: 'key', key: 'enter', times: 1 });
    expect(parseScreenCommand('press escape')).toEqual({ do: 'key', key: 'esc', times: 1 });
    expect(parseScreenCommand('Scroll down twice')).toEqual({ do: 'scroll', dir: 'down', times: 2 });
    expect(parseScreenCommand('Minimize this.')).toEqual({ do: 'window', action: 'minimize' });
    expect(parseScreenCommand('Switch to WhatsApp.')).toEqual({ do: 'focus', app: 'WhatsApp' });
    expect(parseScreenCommand('Bring WhatsApp to the front')).toEqual({ do: 'focus', app: 'WhatsApp' });
    expect(parseScreenCommand("What's on the screen?")).toEqual({ do: 'look' });
    expect(parseScreenCommand('List the buttons')).toEqual({ do: 'list' });
    expect(parseScreenCommand('Open a new tab')).toEqual({ do: 'key', key: 'ctrl+t', times: 1, say: 'New tab.' });
    expect(parseScreenCommand('go back')).toEqual({ do: 'key', key: 'alt+left', times: 1, say: 'Went back.' });
    expect(parseScreenCommand('What did you just do?')).toEqual({ do: 'last' });
    expect(parseScreenCommand('undo that')).toEqual({ do: 'undo' });
    expect(parseScreenCommand('close this window')).toEqual({ do: 'window', action: 'close' });
    expect(parseScreenCommand('what is the weather today')).toBe(null);
  });

  it('only "start screen control" turns it on from outside', () => {
    expect(isScreenModeStart('Novi, start screen control')).toBe(true);
    expect(isScreenModeStart('screen mode on')).toBe(true);
    expect(isScreenModeStart('click 3')).toBe(false);
  });

  it('picks search results top to bottom, skipping the page chrome', () => {
    expect(pickResult(GOOGLE.items, 2).name).toMatch(/^Sign in to GitHub/);
    expect(pickResult(GOOGLE.items, 9)).toBe(null);
  });
});

describe('screen mode: doing it', () => {
  it('says what it is when it starts and stops, and ignores other words while off', async () => {
    const s = setup();
    expect((await s.say('click 3')).unknown).toBe(true);
    const out = await s.say('start screen control');
    expect(out.note).toBe("Screen control is on. I'll follow your voice commands. Say 'stop screen control' to end it.");
    expect(out.mode).toBe('on');
    expect((await s.say('what is the weather')).unknown).toBe(true);
    const stop = await s.say('stop screen control');
    expect(stop).toMatchObject({ mode: 'off', note: 'Screen control is off.' });
    expect((await s.say('click 3')).unknown).toBe(true);
  });

  it('"open Chrome" focuses an open Chrome, else asks the agent to launch it', async () => {
    const s = await on(setup());
    expect((await s.say('open chrome')).note).toBe('Chrome is in front.');
    const s2 = await on(setup({ windows: [] }));
    expect(await s2.say('open notion')).toMatchObject({ run: { tool: 'open_app', args: { name: 'notion' } }, say: 'Notion is open.' });
  });

  it('"search for GitHub" opens a search page on the laptop', async () => {
    const s = await on(setup());
    expect(await s.say('search for GitHub')).toMatchObject({ run: { tool: 'open_website', args: { url: 'https://www.google.com/search?q=GitHub', on: 'laptop' } }, say: 'Searching for GitHub.' });
  });

  it('"open the second result" clicks the second visible result, no AI', async () => {
    const s = await on(setup());
    const out = await s.say('open the second result');
    expect(s.actions.at(-1)).toEqual(['click', 500, 420]);
    expect(out.note).toBe('Opened the second result.');
  });

  it('"click login" finds and clicks a Sign in link on an ordinary page', async () => {
    const s = await on(setup());
    expect((await s.say('click login')).note).toBe('Clicked Sign in.');
    expect(s.actions.at(-1)).toEqual(['click', 1800, 60]);
  });

  it('"type Novi AI" types into the app in front (brought forward first)', async () => {
    const s = await on(setup({ front: 'NOVI - Google Chrome' }));
    expect((await s.say('type Novi AI')).note).toBe('Typed it.');
    expect(s.actions).toEqual([['focus', GOOGLE.title], ['type', 'Novi AI']]);
  });

  it('"type this in the search box: Novi AI" clicks the box first', async () => {
    const s = await on(setup());
    await s.say('type this in the search box: Novi AI');
    expect(s.actions).toEqual([['click', 400, 120], ['type', 'Novi AI']]);
  });

  it('"press enter" sends the key; keys it does not know are refused', async () => {
    const s = await on(setup());
    expect((await s.say('press enter')).note).toBe('Pressed Enter.');
    expect(s.actions.at(-1)).toEqual(['key', 'enter']);
    expect((await s.say('press f13')).note).toMatch(/can't press/i);
  });

  it('"scroll down twice" scrolls the window under it', async () => {
    const s = await on(setup());
    await s.say('scroll down twice');
    expect(s.actions.at(-1)).toEqual(['scroll', -6]);
  });

  it('"minimize this" minimizes the front window; "switch to WhatsApp" focuses it', async () => {
    const s = await on(setup());
    expect((await s.say('minimize this')).note).toBe('Minimized.');
    expect(s.calls.at(-1)).toEqual(['laptop_window', { app: 'this', do: 'minimize' }]);
    expect((await s.say('switch to WhatsApp')).note).toBe('WhatsApp is in front.');
    expect(s.calls.at(-1)).toEqual(['laptop_window', { app: 'WhatsApp', do: 'focus' }]);
  });

  it('a closed app is offered, and "yes" opens it', async () => {
    const s = await on(setup({ windows: [] }));
    expect((await s.say('switch to Spotify')).note).toBe("Spotify isn't open. Should I open it?");
    expect(await s.say('yes')).toMatchObject({ run: { tool: 'open_app', args: { name: 'Spotify' } } });
  });

  it('"click 3" uses the last numbered list', async () => {
    const s = await on(setup());
    const list = await s.say('list the screen');
    expect(list.note).toMatch(/^\d+ things on GitHub - Google Search/);
    expect(list.note).toMatch(/\n1\. box: Search/);
    await s.say('click 1');
    expect(s.actions.at(-1)).toEqual(['click', 400, 120]);
  });

  it('a visual description falls back to vision', async () => {
    const s = await on(setup());
    await s.say('click the green circle');
    expect(s.actions.at(-1)).toEqual(['click', 500, 500]);
  });

  it('"what did you just do" and "undo that" after typing', async () => {
    const s = await on(setup());
    await s.say('type hello');
    expect((await s.say('what did you just do')).note).toMatch(/typed/i);
    await s.say('undo that');
    expect(s.actions.at(-1)).toEqual(['key', 'ctrl+z']);
  });

  it('logs every action with what was said, the window, the result and the time taken', async () => {
    const s = await on(setup());
    await s.say('click login');
    const lines = fs.readFileSync(path.join(s.dir, 'screen', 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ said: 'click login', window: GOOGLE.title, action: 'click', target: 'Sign in', vision: false, result: 'Clicked Sign in.' });
    expect(typeof lines.at(-1).ms).toBe('number');
    expect(lines.at(-1).at).toBeTruthy();
  });
});

describe('screen mode: safety', () => {
  const LOGIN = { title: 'Sign in to GitHub · GitHub - Google Chrome', items: [{ type: 'Edit', name: 'Username or email address', x: 10, y: 10 }, { type: 'Edit', name: 'Password', x: 10, y: 50 }, { type: 'Button', name: 'Sign in', x: 10, y: 90 }] };

  it('refuses to click or type on a password screen', async () => {
    const s = await on(setup({ screen: LOGIN }));
    expect((await s.say('click sign in')).note).toBe('This looks sensitive. Please do this part yourself.');
    expect((await s.say('type hello')).note).toBe('This looks sensitive. Please do this part yourself.');
    expect(s.actions.filter((a) => a[0] === 'click' || a[0] === 'type')).toEqual([]);
  });

  it('never types passwords said aloud', async () => {
    const s = await on(setup());
    expect((await s.say('type my password hunter2')).note).toBe("I can't type passwords aloud. Please type it yourself.");
  });

  it('payments are refused before anything happens', async () => {
    const s = await on(setup());
    expect(await s.gate('click buy now')).toMatchObject({ block: true, blockReason: 'This looks sensitive. Please do this part yourself.' });
  });

  it('a destructive click needs the voice PIN, saying exactly what will happen', async () => {
    const s = await on(setup());
    const gate = await s.gate('click delete repository');
    expect(gate.approval).toMatchObject({ pin: true, grantable: false });
    expect(gate.approval.title).toBe('Click “Delete repository” in GitHub - Google Search');
  });

  it('ordinary commands need no approval once the user started it; the AI choosing it does', async () => {
    const s = await on(setup());
    expect(await s.gate('click login')).toEqual({});
    expect((await s.gate('click login', false)).approval).toMatchObject({ category: 'screen' });
  });

  it('closing a window goes to the window tool, which asks', async () => {
    const s = await on(setup());
    expect(await s.say('close this window')).toMatchObject({ run: { tool: 'laptop_window', args: { app: 'this', do: 'close' } } });
  });

  it('turns itself off after a quiet spell', async () => {
    let t = 0;
    const s = setup();
    const plugin = createScreenPlugin({ driver: {}, now: () => t });
    const host = new PluginHost({ runtime: { dataDir: s.dir }, env: {}, logger: { warn() {} } });
    host.register(plugin);
    await host.get('screen_command').run({ text: 'start screen control' });
    t = 16 * 60_000;
    expect((await host.get('screen_command').run({ text: 'click 3' })).unknown).toBe(true);
    expect(host.get('screen_state') && (await host.get('screen_state').run({})).on).toBe(false);
  });
});
