import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { listClaudeCodeProjects } from '../../plugins/claude-link/codeProjects.js';
import { createClaudeWeb } from '../../plugins/claude-link/claudeWeb.js';
import { createClaudeLinkPlugin } from '../../plugins/claude-link/index.js';
import { claudeLinkCommand } from '../../server/brain/claudeLinkCommand.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-claude-link-'));
const line = (o) => JSON.stringify(o);

// ~/.claude/projects/<folder>/<session>.jsonl, the way Claude Code keeps its conversations.
function session(home, folder, cwd, { first = 'build my portfolio site', summary = null, mtime = null, file = 's1.jsonl' } = {}) {
  const dir = path.join(home, '.claude', 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    ...(summary ? [line({ type: 'summary', summary })] : []),
    line({ type: 'user', cwd, sessionId: 'x', message: { role: 'user', content: '<command-name>/init</command-name>' } }),
    line({ type: 'user', cwd, sessionId: 'x', message: { role: 'user', content: [{ type: 'text', text: first }] } }),
  ];
  const f = path.join(dir, file);
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(f, mtime, mtime);
}

describe('Claude Code projects on the laptop', () => {
  it('lists every folder Claude Code worked in, newest first, with what it was about', () => {
    const home = tmp();
    const portfolio = path.join(home, 'Projects', 'Portfolio');
    const calc = path.join(home, 'Projects', 'calc');
    fs.mkdirSync(path.join(portfolio, 'src'), { recursive: true });
    fs.mkdirSync(calc, { recursive: true });
    session(home, 'p1', portfolio, { summary: 'Portfolio with a blog', mtime: new Date(2026, 9, 17) });
    session(home, 'p1', portfolio, { file: 's2.jsonl', mtime: new Date(2026, 9, 10) });
    session(home, 'c1', calc, { first: 'make a calculator', mtime: new Date(2026, 9, 1) });
    session(home, 'sub', path.join(portfolio, 'src'), { mtime: new Date(2026, 9, 18) }); // inside portfolio
    session(home, 'gone', path.join(home, 'Projects', 'deleted')); // folder no longer there
    session(home, 'home', home); // Claude opened in the home folder: not a project
    const out = listClaudeCodeProjects({ home });
    expect(out.map((p) => p.name)).toEqual(['Portfolio', 'calc']);
    expect(out[0]).toMatchObject({ path: portfolio, sessions: 2, about: 'Portfolio with a blog' });
    expect(new Date(out[0].lastUsed).toLocaleDateString('en-CA')).toBe('2026-10-17');
    expect(out[1].about).toBe('make a calculator');
  });

  it('no Claude Code folder → nothing, never an error', () => {
    expect(listClaudeCodeProjects({ home: tmp() })).toEqual([]);
  });
});

// A fake Chrome: claude.ai pages as the extension would answer them.
function fakeChrome({ cards = ['Novi\nVoice assistant', 'Old notes'], loggedIn = true, makeUrl = 'https://claude.ai/project/0193-abc' } = {}) {
  const calls = [];
  let url = 'about:blank';
  const request = async (cmd, args = {}) => {
    calls.push([cmd, args]);
    if (cmd === 'open') { url = args.url; return { tabId: 7 }; }
    if (cmd === 'tabs') return { tabs: [{ id: 7, url }] };
    if (cmd === 'waitFor') return { found: loggedIn };
    if (cmd === 'has') return { found: !loggedIn && /login|Log in/.test(args.selector) };
    if (cmd === 'query') return { texts: cards };
    if (cmd === 'clickSel') { if (/submit/.test(args.selector)) url = makeUrl; return {}; }
    return {};
  };
  return { request, calls, url: () => url };
}

describe('claude.ai Projects through Chrome', () => {
  const quick = { sleep: async () => {}, pollMs: 1, maxMs: 50 };

  it('reads the names of your claude.ai projects', async () => {
    const c = fakeChrome();
    const web = createClaudeWeb({ request: c.request, ...quick });
    expect(await web.list()).toEqual({ names: ['Novi', 'Old notes'] });
    expect(c.calls[0]).toEqual(['open', { url: 'https://claude.ai/projects', newTab: true, background: true }]);
  });

  it('makes a project: name, description, then the instructions', async () => {
    const c = fakeChrome();
    const web = createClaudeWeb({ request: c.request, ...quick });
    const out = await web.make({ name: 'Portfolio', description: 'My portfolio site', instructions: 'Code is in C:\\Projects\\Portfolio.' });
    expect(out).toEqual({ url: 'https://claude.ai/project/0193-abc' });
    const typed = c.calls.filter(([cmd]) => cmd === 'typeSel').map(([, a]) => a.text);
    expect(typed).toEqual(['Portfolio', 'My portfolio site', 'Code is in C:\\Projects\\Portfolio.']);
    expect(c.calls.some(([cmd, a]) => cmd === 'clickSel' && /instructions/i.test(a.text || ''))).toBe(true);
  });

  it('not logged in → says so', async () => {
    const web = createClaudeWeb({ request: fakeChrome({ loggedIn: false }).request, ...quick });
    expect(await web.list()).toMatchObject({ login: true, error: expect.stringMatching(/Log in to Claude in Chrome/) });
  });

  it('the project page never shows up → an error, not a made-up link', async () => {
    const web = createClaudeWeb({ request: fakeChrome({ makeUrl: 'https://claude.ai/projects/create' }).request, ...quick });
    expect(await web.make({ name: 'X', description: 'x', instructions: 'x' })).toMatchObject({ error: expect.stringMatching(/didn't open/) });
  });
});

function setup({ known = [], web = {}, connected = true, codeProjects = [] } = {}) {
  const dataDir = tmp();
  const remembered = [...known];
  const notes = [];
  const made = [];
  const jobs = [];
  const runtime = {
    dataDir,
    projects: {
      list: () => remembered.map((p) => ({ ...p })),
      remember: (name, p) => { remembered.push({ name: name.toLowerCase(), path: p }); return { name: name.toLowerCase(), path: p }; },
    },
    codingProject: (n) => remembered.find((p) => p.name === String(n).toLowerCase()) || null,
    browserStatus: () => ({ connected }),
    wikiWrite: (n) => { notes.push(n); return { title: n.title }; },
    wikiRead: () => null,
  };
  const driver = {
    list: async () => web.list || { names: [] },
    make: async (a) => { made.push(a); return web.make || { url: 'https://claude.ai/project/1' }; },
  };
  const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
  expect(host.register(createClaudeLinkPlugin({ driver, listCode: () => codeProjects, track: (p) => jobs.push(p), now: () => new Date(2026, 9, 18) }))).toBe(true);
  const run = (name, args = {}) => host.get(name).run(args);
  return { host, run, remembered, notes, made, jobs, dataDir };
}

describe('claude-link plugin', () => {
  it('sync: Claude Code folders Novi didn\'t know become her projects, each with a note', async () => {
    const s = setup({
      known: [{ name: 'novi', path: '/p/NOVI' }, { name: 'calc', path: '/other/calc' }],
      codeProjects: [
        { name: 'Portfolio', path: '/p/Portfolio', lastUsed: '2026-10-17T06:00:00Z', sessions: 3, about: 'Portfolio with a blog' },
        { name: 'NOVI', path: '/p/NOVI', lastUsed: '2026-10-18T10:00:00Z', sessions: 40, about: 'x' },
        { name: 'calc', path: '/p/calc', lastUsed: '2026-10-01T10:00:00Z', sessions: 1, about: 'y' },
      ],
      web: { list: { names: ['Portfolio', 'Old notes'] } },
    });
    const out = await s.run('claude_projects_sync');
    expect(s.remembered.map((p) => p.name)).toEqual(['novi', 'calc', 'portfolio']);
    expect(s.notes[0].title).toBe('Portfolio project');
    expect(s.notes[0].text).toMatch(/Folder: \/p\/Portfolio\nLast worked on in Claude Code: 2026-10-17 \(3 conversations\)\nAbout: Portfolio with a blog/);
    expect(out.note).toBe('I know 3 Claude Code projects now: 1 new (Portfolio). 1 has a name I already use (calc). On claude.ai you have 2 projects: Portfolio, Old notes.');
    expect(out.added).toEqual(['Portfolio']);
  });

  it('make: a claude.ai project with the folder in its instructions, remembered and noted', async () => {
    const s = setup({ known: [{ name: 'portfolio', path: '/p/Portfolio' }] });
    const out = await s.run('claude_project_make', { project: 'portfolio' });
    expect(out.note).toBe('Making the Portfolio project on claude.ai in Chrome…');
    await s.jobs.at(-1);
    expect(s.made[0]).toMatchObject({ name: 'Portfolio' });
    expect(s.made[0].instructions).toMatch(/\/p\/Portfolio/);
    expect(s.notes.at(-1)).toEqual({ title: 'Portfolio project', text: 'On claude.ai: https://claude.ai/project/1 (made 2026-10-18)' });
    const again = await s.run('claude_project_make', { project: 'portfolio' });
    expect(again.note).toBe('Portfolio is already on claude.ai: https://claude.ai/project/1');
  });

  it('make: already on claude.ai under that name → not made twice', async () => {
    const s = setup({ known: [{ name: 'portfolio', path: '/p/Portfolio' }], web: { list: { names: ['portfolio'] } } });
    await s.run('claude_project_make', { project: 'portfolio' });
    await s.jobs.at(-1);
    expect(s.made).toEqual([]);
  });

  it('make: Chrome not connected or an unknown project → said plainly', async () => {
    expect((await setup({ known: [{ name: 'portfolio', path: '/p/P' }], connected: false }).run('claude_project_make', { project: 'portfolio' })).error)
      .toMatch(/Chrome isn't connected/);
    expect((await setup().run('claude_project_make', { project: 'nope' })).error).toMatch(/don't know a project called nope/);
  });

  it('every new project and every coding task on a project not on claude.ai yet gets one, in the background', async () => {
    const s = setup({ known: [{ name: 'shop', path: '/p/shop' }, { name: 'portfolio', path: '/p/Portfolio' }] });
    await s.host.afterToolCall({ toolName: 'code_new_project', params: { name: 'shop', description: 'A shoe shop' }, result: { created: '/p/shop', project: 'shop' } });
    await s.jobs.at(-1);
    expect(s.made[0]).toMatchObject({ name: 'shop', description: 'A shoe shop' });
    await s.host.afterToolCall({ toolName: 'code_start_task', params: { project: 'portfolio' }, result: { started: true, project: 'portfolio' } });
    await s.jobs.at(-1);
    expect(s.made.map((m) => m.name)).toEqual(['shop', 'Portfolio']);
    // Already linked, failed runs and other tools: nothing.
    await s.host.afterToolCall({ toolName: 'code_start_task', params: { project: 'portfolio' }, result: { started: true, project: 'portfolio' } });
    await s.host.afterToolCall({ toolName: 'code_start_task', params: { project: 'shop' }, error: 'x', result: { error: 'x' } });
    await s.host.afterToolCall({ toolName: 'file_open', params: {}, result: {} });
    await Promise.all(s.jobs);
    expect(s.made).toHaveLength(2);
  });

  it('anything Novi starts on claude.ai by herself asks first (AI-chosen calls)', async () => {
    const s = setup();
    const g = await s.host.get('claude_project_make').gate({ project: 'portfolio' });
    expect(g.approval).toMatchObject({ tier: 'medium', title: 'Make a claude.ai project for portfolio' });
  });
});

describe('claude-link by voice', () => {
  it.each([
    ['put the portfolio project on Claude', { tool: 'claude_project_make', args: { project: 'portfolio' } }],
    ['add portfolio to my Claude projects', { tool: 'claude_project_make', args: { project: 'portfolio' } }],
    ['make a Claude project for calculator maker', { tool: 'claude_project_make', args: { project: 'calculator maker' } }],
    ['create the shop project in claude.ai', { tool: 'claude_project_make', args: { project: 'shop' } }],
    ['sync my Claude projects', { tool: 'claude_projects_sync', args: {} }],
    ['connect Novi to Claude', { tool: 'claude_projects_sync', args: {} }],
    ['bring in all my old projects from Claude', { tool: 'claude_projects_sync', args: {} }],
    ['remember all my Claude Code projects', { tool: 'claude_projects_sync', args: {} }],
  ])('%s', (text, want) => {
    expect(claudeLinkCommand(text)).toEqual(want);
  });

  it.each(['tell Claude to add a blog to portfolio', 'open portfolio in Claude', 'make a new project called shop', 'put the song on'])('not this: %s', (text) => {
    expect(claudeLinkCommand(text)).toBeNull();
  });
});
