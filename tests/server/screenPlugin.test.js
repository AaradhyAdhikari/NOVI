import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createScreenPlugin, toPixels, KEYS } from '../../plugins/screen/index.js';

function setup({ window = 'WhatsApp', found = { found: true, point: [500, 250], sensitive: false }, look = 'A chat app with a Send button.', items = null, focusAll = false } = {}) {
  const actions = [];
  const prompts = [];
  const driver = {
    screenshot: async () => ({ png: Buffer.from('PNG'), width: 1920, height: 1080 }),
    window: async () => window,
    click: async (x, y) => actions.push(['click', x, y]),
    type: async (text) => actions.push(['type', text]),
    key: async (name) => actions.push(['key', name]),
    focus: async (app) => { actions.push(['focus', app]); return focusAll || /whatsapp/i.test(app); },
    pageShot: async (url) => { actions.push(['pageShot', url]); return { png: Buffer.from('PAGE') }; },
    ...(items ? { items: async () => items } : {}),
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

  // Live (2026-10-17): asked for the portfolio's homepage, the AI also sent the laptop screen and
  // called it the portfolio.
  it('screen_show tells the AI it is never a project website (that is preview_show)', async () => {
    const { host } = setup();
    expect(host.get('screen_show').description).toMatch(/Never use it for a coding project's website.*preview_show/);
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

// Live (2026-10-17): the AI deleted a folder by pressing Delete in File Explorer. Screen control never deletes.
describe('screen control never deletes', () => {
  it('Delete keys in File Explorer and clicks on "Delete" / "Move to Recycle Bin" are refused', async () => {
    const s = setup({ window: 'test2 - File Explorer' });
    for (const [tool, params] of [['screen_key', { key: 'delete', app: 'File Explorer' }], ['screen_key', { key: 'shift+delete', app: 'explorer' }], ['screen_key', { key: 'delete', app: 'test2' }], ['screen_click', { target: 'Delete', app: 'File Explorer' }], ['screen_click', { target: 'Move to Recycle Bin', app: 'Chrome' }]]) {
      const gate = await s.gate(tool, params);
      expect(gate, tool + JSON.stringify(params)).toMatchObject({ block: true });
      expect(gate.blockReason).toMatch(/file_delete|PIN/);
    }
    expect((await s.gate('screen_key', { key: 'delete', app: 'Notepad' })).approval).toBeTruthy(); // deleting text is fine
  });
});

// Live 2026-10-22: "Play the first video on screen" (Kick in Brave) failed — screen control saw the screen
// only through Gemini vision, which was overloaded (503). Windows' accessibility tree (UI Automation) lists
// every link, button and video tile of the front window with its name and position — no AI needed.
describe('what is on the screen, as a list (no AI)', () => {
  const KICK = { title: 'snaxgaming Live Stream - Watch Live on KICK - Brave', items: [
    { type: 'Button', name: 'Back', x: 22, y: 76, w: 30, h: 30 },
    { type: 'ListItem', name: 'snaxgaming snaxgaming PUBG Mobile 3.2K', x: 160, y: 575, w: 280, h: 60 },
    { type: 'Hyperlink', name: 'snaxgaming snaxgaming PUBG Mobile 3.2K', x: 160, y: 575, w: 280, h: 60 },
    { type: 'Hyperlink', name: 'Binks69 DUKH BEGIN... 5 hours ago', x: 485, y: 760, w: 260, h: 200 },
    { type: 'Edit', name: 'Password', x: 900, y: 500, w: 200, h: 30 },
  ] };
  const withItems = (opts = {}) => {
    const s = setup({ window: KICK.title, items: KICK, ...opts });
    s.host.runtime.vision = async (png, prompt) => { s.prompts.push(prompt); return JSON.stringify({ found: true, point: [500, 500], sensitive: false }); };
    return s;
  };

  it('screen_items: numbered things on screen, one per place, never password fields; read-only', async () => {
    const s = withItems();
    expect(await s.gate('screen_items', { app: 'Brave' })).toEqual({});
    const out = await s.run('screen_items', { app: 'Brave' });
    expect(out.text).toMatch(/^On "snaxgaming Live Stream - Watch Live on KICK - Brave":/);
    expect(out.text).toMatch(/1\. link: snaxgaming snaxgaming PUBG Mobile 3\.2K/);
    expect(out.text).toMatch(/2\. link: Binks69 DUKH BEGIN\.\.\. 5 hours ago/);
    expect(out.text).toMatch(/3\. button: Back/); // the browser's own buttons come last
    expect(out.text).not.toMatch(/Password/);
    expect(out.sensitive).toBe(true);
  });

  it('screen_click by number (from the last list) or by its words — no vision', async () => {
    const s = withItems();
    await s.run('screen_items', { app: 'Brave' });
    expect((await s.gate('screen_click', { n: 2, app: 'Brave' })).approval.title).toBe('Click “Binks69 DUKH BEGIN... 5 hours ago”');
    expect((await s.run('screen_click', { n: 2, app: 'Brave' })).text).toBe('Clicked “Binks69 DUKH BEGIN... 5 hours ago”.');
    expect(s.actions.at(-1)).toEqual(['click', 420, 820]); // a tall link: its title line (clickPoint), still inside the tile
    await s.run('screen_click', { target: 'snaxgaming', app: 'Brave' });
    expect(s.actions.at(-1)).toEqual(['click', 90, 593]); // a tall link too
    expect(s.prompts).toEqual([]); // vision never asked
  });

  it('words not in the list → vision as before; a number with no list → asks to look first', async () => {
    const s = withItems();
    await s.run('screen_click', { target: 'the play button on the big video', app: 'Brave' });
    expect(s.prompts).toHaveLength(1);
    const fresh = withItems();
    expect((await fresh.run('screen_click', { n: 2, app: 'Brave' })).text).toMatch(/list what's on the screen first/i);
  });
});

// Talking to Novi on the laptop puts Novi's own page in front: "the screen" means the app behind it.
describe("the screen behind Novi's own page", () => {
  const KICK = { title: 'snaxgaming Live Stream - Watch Live on KICK - Brave', items: [{ type: 'Hyperlink', name: 'Binks69 DUKH BEGIN... 5 hours ago', x: 485, y: 760 }] };
  it('no app named: the list is of the app behind; clicking brings it forward first', async () => {
    const s = setup({ window: 'NOVI — Personal AI Companion - Google Chrome', items: KICK, focusAll: true });
    expect((await s.run('screen_items', {})).text).toMatch(/^On "snaxgaming Live Stream/);
    expect((await s.run('screen_click', { n: 1 })).text).toBe('Clicked “Binks69 DUKH BEGIN... 5 hours ago”.');
    expect(s.actions.slice(-2)).toEqual([['focus', KICK.title], ['click', 485, 760]]);
    await s.run('screen_click', { target: 'binks69' });
    expect(s.actions.slice(-2)).toEqual([['focus', KICK.title], ['click', 485, 760]]);
  });
  it('the app behind closed meanwhile → said plainly, nothing clicked', async () => {
    const s = setup({ window: 'NOVI — Personal AI Companion - Google Chrome', items: KICK, focusAll: false });
    await s.run('screen_items', {});
    expect((await s.run('screen_click', { n: 1 })).text).toMatch(/isn't open any more/);
    expect(s.actions.some(([k]) => k === 'click')).toBe(false);
  });
});
