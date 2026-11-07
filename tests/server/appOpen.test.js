import { describe, it, expect } from 'vitest';
import { resolveApp, launchApp } from '../../server/laptop/apps.js';
import { appCommand } from '../../server/brain/appCommand.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import { addLaptopTools } from '../../server/laptop/laptopTools.js';

// Checklist rows open2-open4: any installed app by name, said loosely or in Hinglish, and said plainly when not.
const APPS = [
  { name: 'Visual Studio Code', appId: 'vscode' }, { name: 'Google Chrome', appId: 'chrome' }, { name: 'Microsoft Edge', appId: 'edge' },
  { name: 'WhatsApp', appId: 'wa' }, { name: 'Spotify', appId: 'sp' }, { name: 'Calculator', appId: 'calc' }, { name: 'File Explorer', appId: 'fe' },
  { name: 'Word', appId: 'word' }, { name: 'PowerPoint', appId: 'ppt' }, { name: 'Aimlabs', appId: 'steam://rungameid/714010' }, { name: 'Telegram Desktop', appId: 'tg' },
];
const name = (q) => resolveApp(APPS, q)?.app?.name;

describe('finding an app from loose words', () => {
  it('everyday short names', () => {
    expect(name('vs code')).toBe('Visual Studio Code');
    expect(name('vscode')).toBe('Visual Studio Code');
    expect(name('chrome')).toBe('Google Chrome');
    expect(name('calc')).toBe('Calculator');
    expect(name('explorer')).toBe('File Explorer');
    expect(name('ppt')).toBe('PowerPoint');
  });
  it('spaces and small slips', () => {
    expect(name('whats app')).toBe('WhatsApp');
    expect(name('spotifi')).toBe('Spotify');
    expect(name('telegram')).toBe('Telegram Desktop');
  });
  it('a bigger slip is offered, never opened by itself', () => {
    const r = resolveApp(APPS, 'spotfy app');
    expect(r?.app?.name ?? r?.suggest?.name).toBe('Spotify');
    expect(resolveApp(APPS, 'calculater')).toEqual({ app: APPS[5] });
    expect(resolveApp(APPS, 'wattsap').suggest.name).toBe('WhatsApp');
  });
  it('nothing near it is nothing, and short words never guess', () => {
    expect(resolveApp(APPS, 'photoshop')).toBe(null);
    expect(resolveApp([{ name: 'Photos', appId: 'p' }], 'photoshop')).toBe(null); // live: "Did you mean Photos?"
    expect(resolveApp(APPS, 'wo')).toBe(null);
  });
});

describe('launching', () => {
  it('a Store or desktop app goes through the Start menu id', async () => {
    const calls = [];
    await launchApp('vscode', { spawnImpl: (c, a) => { calls.push([c, a]); return {}; } });
    expect(calls[0]).toEqual(['explorer.exe', ['shell:AppsFolder\\vscode']]);
  });
  it('a Steam game opens by its own link', async () => {
    const calls = [];
    await launchApp('steam://rungameid/714010', { spawnImpl: (c, a) => { calls.push([c, a]); return {}; } });
    expect(calls[0]).toEqual(['explorer.exe', ['steam://rungameid/714010']]);
  });
});

describe('the words', () => {
  it('English', () => {
    for (const t of ['open spotify', 'Okay, open Spotify.', 'launch spotify', 'start spotify', 'please open the spotify app', 'open spotify on my laptop']) expect(appCommand(t), t).toEqual({ name: 'spotify', orSite: false });
  });
  it('Hinglish', () => {
    for (const t of ['spotify kholo', 'spotify khol do', 'spotify chalu karo', 'spotify start karo', 'spotify open karo', 'spotify shuru karo']) expect(appCommand(t), t).toEqual({ name: 'spotify', orSite: true });
    expect(appCommand('vs code kholo')).toEqual({ name: 'vs code', orSite: true });
  });
  it('leaves other things alone', () => {
    for (const t of ['open the login page', 'open this link', 'open my resume file', 'open the tab', 'start the timer for 5 minutes', 'start screen control', 'open github.com', 'wifi chalu karo', 'open spotify and play lofi', 'start a new project called shop', 'what apps do I have']) expect(appCommand(t), t).toBe(null);
  });
});

describe('open_app', () => {
  const tools = (launched = []) => addLaptopTools(new ToolRegistry(), { catalog: { all: async () => APPS }, launchApp: async (id) => launched.push(id) });
  it('opens what it finds', async () => {
    const launched = [];
    expect(await tools(launched).get('open_app').run({ name: 'vs code' })).toMatchObject({ opened: 'Visual Studio Code' });
    expect(launched).toEqual(['vscode']);
  });
  it('a near miss asks, and opens nothing', async () => {
    const launched = [];
    const out = await tools(launched).get('open_app').run({ name: 'wattsap' });
    expect(out).toMatchObject({ notFound: true, suggest: 'WhatsApp' });
    expect(out.error).toMatch(/Did you mean WhatsApp/);
    expect(launched).toEqual([]);
  });
  it('nothing found is said plainly', async () => {
    const out = await tools().get('open_app').run({ name: 'photoshop' });
    expect(out).toMatchObject({ notFound: true });
    expect(out.error).toBe('I couldn\'t find an app called "photoshop" on this laptop.');
  });
});
