import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createScreenPlugin, toPixels, KEYS } from '../../plugins/screen/index.js';

function setup({ window = 'WhatsApp', found = { found: true, point: [500, 250], sensitive: false }, look = 'A chat app with a Send button.' } = {}) {
  const actions = [];
  const prompts = [];
  const driver = {
    screenshot: async () => ({ png: Buffer.from('PNG'), width: 1920, height: 1080 }),
    window: async () => window,
    click: async (x, y) => actions.push(['click', x, y]),
    type: async (text) => actions.push(['type', text]),
    key: async (name) => actions.push(['key', name]),
    focus: async (app) => { actions.push(['focus', app]); return /whatsapp/i.test(app); },
    pageShot: async (url) => { actions.push(['pageShot', url]); return { png: Buffer.from('PAGE') }; },
  };
  const shown = [];
  const vision = async (png, prompt) => {
    prompts.push(prompt);
    return /JSON/.test(prompt) ? JSON.stringify(found) : look;
  };
  const host = new PluginHost({ runtime: { vision, showImage: (img) => shown.push(img) }, env: {}, logger: { warn() {} } });
  expect(host.register(createScreenPlugin({ driver }))).toBe(true);
  return { host, actions, prompts, shown, run: (n, p) => host.get(n).run(p), gate: (n, p) => host.get(n).gate(p) };
}

describe('screen plugin', () => {
  it('converts Gemini points (0-1000 grid, [y, x]) to screen pixels', () => {
    expect(toPixels([500, 250], 1920, 1080)).toEqual({ x: 480, y: 540 });
  });

  it('screen_look describes the screen privately, without approval', async () => {
    const { run, gate, prompts } = setup();
    expect(await gate('screen_look', { question: "what's open?" })).toEqual({});
    const out = await run('screen_look', { question: "what's open?" });
    expect(out.text).toBe('A chat app with a Send button.');
    expect(out.sensitive).toBe(true);
    expect(prompts[0]).toMatch(/what's open\?/);
  });

  it('clicking asks for approval in the grantable "screen" category', async () => {
    const { gate } = setup();
    expect((await gate('screen_click', { target: 'the Send button', app: 'WhatsApp' })).approval).toMatchObject({ title: 'Click “the Send button”', tier: 'medium', category: 'screen', grantable: true });
  });

  it('finds the target with vision and clicks its centre', async () => {
    const { run, actions } = setup();
    const out = await run('screen_click', { target: 'the Send button', app: 'WhatsApp' });
    expect(actions).toEqual([['click', 480, 540]]);
    expect(out.text).toMatch(/Clicked/);
  });

  it('says so when the target is not on screen', async () => {
    const { run, actions } = setup({ found: { found: false } });
    expect((await run('screen_click', { target: 'the Send button', app: 'WhatsApp' })).text).toMatch(/couldn't find/i);
    expect(actions).toEqual([]);
  });

  it('refuses to act on password, payment, CAPTCHA or system security screens', async () => {
    for (const window of ['Sign in – Google Accounts', 'Checkout - Payment', 'Windows Security', 'Settings', 'User Account Control']) {
      const { run, actions } = setup({ window });
      expect((await run('screen_click', { target: 'OK', app: window })).text, window).toMatch(/won't/i);
      expect((await run('screen_type', { text: 'hello', app: window })).text, window).toMatch(/won't/i);
      expect(actions, window).toEqual([]);
    }
    const flagged = setup({ found: { found: true, point: [10, 10], sensitive: true } });
    expect((await flagged.run('screen_click', { target: 'the field', app: 'WhatsApp' })).text).toMatch(/won't/i);
    expect(flagged.actions).toEqual([]);
    const { run, actions } = setup();
    expect((await run('screen_click', { target: 'the password box', app: 'WhatsApp' })).text).toMatch(/won't/i);
    expect(actions).toEqual([]);
  });

  it('types text after approval (text shown on the card) and presses allowed keys only', async () => {
    const { run, gate, actions } = setup();
    expect((await gate('screen_type', { text: 'hello Rohan', app: 'WhatsApp' })).approval).toMatchObject({ title: 'Type text on screen', detail: 'hello Rohan', category: 'screen' });
    await run('screen_type', { text: 'hello Rohan', app: 'WhatsApp' });
    await run('screen_key', { key: 'Enter', app: 'WhatsApp' });
    expect(actions).toEqual([['type', 'hello Rohan'], ['key', 'enter']]);
    expect((await run('screen_key', { key: 'win+r', app: 'WhatsApp' })).text).toMatch(/can't press/i);
    expect(KEYS).not.toContain('alt+f4');
  });

  it('acts only when the named app really is the active window (no clicking or typing into the wrong app)', async () => {
    const { run, actions, prompts } = setup({ window: 'Claude' });
    expect((await run('screen_click', { target: 'the message box', app: 'Novi screen test' })).text).toMatch(/active window is "Claude"/);
    expect((await run('screen_type', { text: 'Hello', app: 'Novi screen test' })).text).toMatch(/active window is "Claude"/);
    expect((await run('screen_key', { key: 'enter', app: 'Novi screen test' })).text).toMatch(/active window is "Claude"/);
    expect(actions).toEqual([]);
    expect(prompts).toEqual([]); // no screenshot sent to Gemini either
  });

  it('asks which app when none is named', async () => {
    const { run, actions } = setup();
    expect((await run('screen_type', { text: 'Hello' })).text).toMatch(/which app/i);
    expect(actions).toEqual([]);
  });

  it('tells the vision model not to guess', async () => {
    const { run, prompts } = setup();
    await run('screen_click', { target: 'the Send button', app: 'WhatsApp' });
    expect(prompts[0]).toMatch(/do not guess/i);
  });

  it('brings a named app to the front without approval, and says so if it is not open', async () => {
    const { run, gate, actions } = setup();
    expect(await gate('screen_focus', { app: 'WhatsApp' })).toEqual({});
    expect((await run('screen_focus', { app: 'WhatsApp' })).text).toMatch(/front/);
    expect((await run('screen_focus', { app: 'Telegram' })).text).toMatch(/isn't open/);
    expect(actions).toEqual([['focus', 'WhatsApp'], ['focus', 'Telegram']]);
  });

  it('screen_show sends a picture of the laptop screen to the asker, without vision or approval', async () => {
    const { run, gate, shown, prompts } = setup({ window: 'GitHub - Microsoft Edge' });
    expect(await gate('screen_show', {})).toEqual({});
    const out = await run('screen_show', {});
    expect(shown).toEqual([{ png: Buffer.from('PNG'), caption: 'The laptop screen right now.' }]);
    expect(prompts).toEqual([]);
    expect(out.sensitive).toBe(true);
  });

  it('screen_show refuses on password / payment screens', async () => {
    const { run, shown } = setup({ window: 'Sign in - Google Accounts' });
    const out = await run('screen_show', {});
    expect(shown).toEqual([]);
    expect(out.text).toMatch(/won't/);
  });

  it('screen_page sends a picture of a web page', async () => {
    const { run, gate, shown, actions } = setup();
    expect(await gate('screen_page', { url: 'https://github.com/aaradhyadhikari' })).toEqual({});
    await run('screen_page', { url: 'https://github.com/aaradhyadhikari' });
    expect(actions).toContainEqual(['pageShot', 'https://github.com/aaradhyadhikari']);
    expect(shown[0]).toEqual({ png: Buffer.from('PAGE'), caption: 'https://github.com/aaradhyadhikari' });
  });

  it('screen_page only opens http(s) addresses', async () => {
    const { run, shown } = setup();
    const out = await run('screen_page', { url: 'file:///C:/Users/secret.txt' });
    expect(shown).toEqual([]);
    expect(out.text).toMatch(/web address/);
  });
});

