import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickTab, recentDownloads, importCommand, importCard } from '../../plugins/project-import/gather.js';
import { openProjectState } from '../../plugins/project-state/state.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createImportPlugin } from '../../plugins/project-import/index.js';

// "Bring my work in" (2026-11-12, user: "if I go to Nano Banana and did some work there and told Novi to include
// that in our project it should be able to include that… these were just examples, don't make them rule based…
// it should be done for all"). From ANY tab (matched by its own title/address, never a site list), its text and
// big pictures, plus files just downloaded; one card; saved into the project and onto the board.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-import-'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

describe('which tab: the one you named, by its own words, else the one you used last', () => {
  const tabs = [
    { id: 1, title: 'Novi', url: 'https://localhost:3001/', lastAccessed: 900 },
    { id: 2, title: 'Gmail', url: 'https://mail.google.com/', lastAccessed: 800 },
    { id: 3, title: 'Nano Banana - Image', url: 'https://aistudio.google.com/nano-banana', lastAccessed: 500 },
    { id: 4, title: 'Some new AI tool', url: 'https://brandnew.ai/chat/1', lastAccessed: 600 },
    { id: 5, title: 'Novi work', url: 'chrome-extension://abc/work.html', lastAccessed: 950 },
  ];
  const skip = ['localhost:3001', 'chrome-extension:'];
  it('named: matched on its title or address, any site', () => {
    expect(pickTab(tabs, 'nano banana', skip).id).toBe(3);
    expect(pickTab(tabs, 'brandnew', skip).id).toBe(4);
    expect(pickTab(tabs, 'the new AI tool', skip).id).toBe(4);
  });
  it('not named: the most recently used tab that is not Novi\'s own', () => {
    expect(pickTab(tabs, '', skip).id).toBe(2);
  });
  it('named but no tab fits: none (never a guess)', () => {
    expect(pickTab(tabs, 'midjourney', skip)).toBe(null);
  });
});

describe('files you just downloaded', () => {
  it('the last 30 minutes, never programs or private-looking files', () => {
    const dir = tmp();
    const now = Date.now();
    const put = (name, ageMin) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); fs.utimesSync(f, (now - ageMin * 60_000) / 1000, (now - ageMin * 60_000) / 1000); };
    put('banana-1.png', 5); put('logo.svg', 20); put('old.png', 90); put('setup.exe', 2); put('.env', 3); put('id_rsa', 3); put('report.pdf', 10);
    expect(recentDownloads(dir, { now }).map((f) => path.basename(f.path)).sort()).toEqual(['banana-1.png', 'logo.svg', 'report.pdf']);
  });
});

describe('the words', () => {
  it('include / add / bring / put what you did on X into Y', () => {
    expect(importCommand('include what I did on nano banana in the tip calculator project')).toEqual({ tool: 'project_import', args: { project: 'tip calculator', from: 'nano banana' } });
    expect(importCommand('add the work from gemini to novi')).toEqual({ tool: 'project_import', args: { project: 'novi', from: 'gemini' } });
    expect(importCommand('bring that into my portfolio project')).toEqual({ tool: 'project_import', args: { project: 'portfolio' } });
    expect(importCommand('put this in tip calculator')).toEqual({ tool: 'project_import', args: { project: 'tip calculator' } });
    expect(importCommand('save my brandnew.ai work to portfolio')).toEqual({ tool: 'project_import', args: { project: 'portfolio', from: 'brandnew.ai' } });
  });
  it('leaves other sentences alone', () => {
    expect(importCommand('add a dark mode to the tip calculator')).toBe(null);
    expect(importCommand('put on some music')).toBe(null);
  });
});

describe('the card', () => {
  it('says what was found and where it goes', () => {
    const card = importCard({ project: 'Tip', source: { title: 'Nano Banana - Image', host: 'aistudio.google.com' }, images: 3, words: 120, files: ['logo.svg'] });
    expect(card.title).toMatch(/Add work from Nano Banana - Image to Tip\?/);
    expect(card.prompt).toMatch(/3 pictures.*the text.*1 downloaded file.*Add them to Tip\?/);
  });
});

describe('the plugin: harvest → card → saved in the project and on the board', () => {
  function setup({ answer = { allow: true }, harvest, downloads }) {
    const dir = tmp();
    const ps = openProjectState(dir);
    ps.ensure({ id: 'tip', name: 'Tip', path: dir });
    const cards = [];
    const calls = [];
    const rt = {
      logger: { warn() {}, info() {} }, say: () => {},
      projects: { list: () => [{ name: 'Tip', path: dir }] }, codingProject: (n) => (/tip/i.test(n || '') ? { name: 'Tip', path: dir } : null),
      browserStatus: () => ({ connected: true }),
      browserRequest: async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'tabs') return { tabs: [{ id: 7, title: 'Nano Banana', url: 'https://aistudio.google.com/nb', lastAccessed: 5 }] }; if (cmd === 'harvest') return harvest; return {}; },
      ask: async (card) => { cards.push(card); return answer; },
    };
    const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    expect(host.register(createImportPlugin({ downloadsDir: downloads || tmp() }))).toBe(true);
    return { host, dir, cards, calls };
  }
  const harvest = { url: 'https://aistudio.google.com/nb', title: 'Nano Banana', text: 'A banana logo, yellow on blue.\nPrompt: a friendly banana', images: [{ name: 'image-1.png', mime: 'image/png', b64: PNG, w: 1024, h: 1024 }] };

  it('yes → pictures and text saved under assets/imported, an approved input on the board every agent sees', async () => {
    const { host, dir, cards, calls } = setup({ harvest });
    const out = await host.get('project_import').run({ project: 'Tip', from: 'nano banana' });
    expect(calls.find(([c]) => c === 'harvest')[1]).toMatchObject({ tabId: 7 });
    expect(cards[0].prompt).toMatch(/1 picture/);
    expect(out.note).toMatch(/Added to Tip/);
    const base = path.join(dir, 'assets', 'imported');
    const folder = path.join(base, fs.readdirSync(base)[0]);
    expect(fs.readdirSync(folder).sort()).toEqual(['image-1.png', 'notes.md']);
    expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toMatch(/aistudio\.google\.com[\s\S]*A banana logo/);
    const t = openProjectState(dir).tasks()[0];
    expect(t).toMatchObject({ role: 'input', status: 'approved', source: 'user' });
    expect(t.summary).toMatch(/assets\/imported/);
  });
  it('no → nothing is saved', async () => {
    const { host, dir } = setup({ harvest, answer: { allow: false } });
    const out = await host.get('project_import').run({ project: 'Tip', from: 'nano banana' });
    expect(out.note).toMatch(/won't add/i);
    expect(fs.existsSync(path.join(dir, 'assets'))).toBe(false);
  });
  it('a secret-looking line in the page text is left out', async () => {
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const { host, dir } = setup({ harvest: { ...harvest, text: `Logo idea\nAPI_KEY=${key}` } });
    await host.get('project_import').run({ project: 'Tip', from: 'nano banana' });
    const base = path.join(dir, 'assets', 'imported');
    const notes = fs.readFileSync(path.join(base, fs.readdirSync(base)[0], 'notes.md'), 'utf8');
    expect(notes).not.toContain(key);
  });
  it('nothing found anywhere: said plainly, no card', async () => {
    const { host, cards } = setup({ harvest: { url: 'x', title: 'Empty', text: '', images: [] } });
    const out = await host.get('project_import').run({ project: 'Tip' });
    expect(out.error).toMatch(/didn't find/i);
    expect(cards).toHaveLength(0);
  });
});

// Live 2026-11-12: "zzz-no-such-tab" matched a Perplexity tab because "no" was found inside "non coders".
describe('a name matches whole words only', () => {
  const tabs = [
    { id: 1, title: 'what were the problems faced by coders and non coders', url: 'https://www.perplexity.ai/search/x', lastAccessed: 9 },
    { id: 2, title: 'Nano Banana - Image', url: 'https://aistudio.google.com/nano-banana', lastAccessed: 5 },
  ];
  it('no tab fits → none', () => {
    expect(pickTab(tabs, 'zzz-no-such-tab', [])).toBe(null);
    expect(pickTab(tabs, 'midjourney', [])).toBe(null);
  });
  it('real names still match', () => {
    expect(pickTab(tabs, 'nano banana', []).id).toBe(2);
    expect(pickTab(tabs, 'perplexity', []).id).toBe(1);
    expect(pickTab(tabs, 'banana', []).id).toBe(2);
  });
});
