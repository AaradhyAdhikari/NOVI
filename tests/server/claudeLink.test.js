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
    for (const box of ['ドキュメント', 'Desktop', 'Downloads', 'OneDrive', 'Projects']) {
      fs.mkdirSync(path.join(home, box), { recursive: true });
      session(home, `box-${box}`, path.join(home, box)); // folders that hold projects aren't projects
    }
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
function fakeChrome({ cards = ['Novi\nVoice assistant', 'Old notes'], later = [], loggedIn = true, makeUrl = 'https://claude.ai/project/0193-abc', oldExtension = false } = {}) {
  let shown = cards;
  const calls = [];
  let url = 'about:blank';
  const request = async (cmd, args = {}) => {
    calls.push([cmd, args]);
    if (cmd === 'open') { url = args.url; return { tabId: 7 }; }
    if (cmd === 'tabs') return { tabs: [{ id: 7, url }] };
    if (cmd === 'waitFor') return { found: loggedIn };
    if (cmd === 'has') return { found: !loggedIn && /login|Log in/.test(args.selector) };
    if (cmd === 'query') {
      if (oldExtension) return { texts: shown.map((c) => c.replace(/\n/g, ' ')) };
      const out = { texts: shown.map((c) => c.split('\n')[0]), values: shown.map((_c, i) => `https://claude.ai/project/p${i + 1}`) };
      if (args.scrollLast) shown = [...cards, ...later];
      return out;
    }
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
    expect(await web.list()).toEqual({ names: ['Novi', 'Old notes'], projects: [{ name: 'Novi', url: 'https://claude.ai/project/p1' }, { name: 'Old notes', url: 'https://claude.ai/project/p2' }] });
    expect(c.calls.find(([cmd]) => cmd === 'query')[1]).toMatchObject({ firstLine: true, attr: 'href', scrollLast: true });
    expect(c.calls[0]).toEqual(['open', { url: 'https://claude.ai/projects', newTab: true, background: true }]);
  });

  it('reads the whole list: scrolls until no new projects show up', async () => {
    const c = fakeChrome({ cards: ['Portfolio', 'AI'], later: ['NOVI', 'TraceBites'] });
    const web = createClaudeWeb({ request: c.request, ...quick });
    expect((await web.list()).names).toEqual(['Portfolio', 'AI', 'NOVI', 'TraceBites']);
    expect(c.calls.find(([cmd]) => cmd === 'query')[1].selector).toBe('a[href*="/project/"]');
  });

  it('an extension that wasn\'t reloaded → says so, never "no projects"', async () => {
    const web = createClaudeWeb({ request: fakeChrome({ oldExtension: true }).request, ...quick });
    expect((await web.list()).error).toMatch(/Reload the Novi extension in chrome:\/\/extensions/);
  });

  it('no project cards on a loaded page → "couldn\'t read", never "no projects"', async () => {
    const web = createClaudeWeb({ request: fakeChrome({ cards: [] }).request, ...quick });
    expect((await web.list()).error).toMatch(/couldn't read your projects on claude\.ai/);
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

function setup({ known = [], web = {}, connected = true, codeProjects = [], dataDir = tmp() } = {}) {
  const recased = [];
  const remembered = [...known];
  const notes = [];
  const made = [];
  const jobs = [];
  const opened = [];
  const runtime = {
    dataDir,
    projects: {
      list: () => remembered.map((p) => ({ ...p })),
      remember: (name, p) => { remembered.push({ name: name.toLowerCase(), path: p }); return { name: name.toLowerCase(), path: p }; },
      forget: (name) => { const i = remembered.findIndex((p) => p.name === name); if (i >= 0) remembered.splice(i, 1); return i >= 0; },
    },
    codingProject: (n) => remembered.find((p) => p.name === String(n).toLowerCase()) || null,
    browserStatus: () => ({ connected }),
    wikiWrite: (n) => { notes.push(n); return { title: n.title }; },
    wikiRead: () => null,
    wikiRecase: (t) => { recased.push(t); return true; },
    callTool: async (name, args) => { opened.push([name, args]); return { opened: true }; },
  };
  const driver = {
    info: async () => web.info || { chats: [] },
    list: async () => web.list || { names: [] },
    make: async (a) => { made.push(a); return web.make || { url: 'https://claude.ai/project/1' }; },
  };
  const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
  expect(host.register(createClaudeLinkPlugin({ driver, listCode: () => codeProjects, track: (p) => jobs.push(p), now: () => new Date(2026, 9, 18) }))).toBe(true);
  const run = (name, args = {}) => host.get(name).run(args);
  return { host, run, remembered, notes, made, jobs, dataDir, opened, runtime, recased };
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
      web: { list: { names: ['Portfolio', 'Old notes'], projects: [{ name: 'Portfolio', url: 'https://claude.ai/project/p1' }, { name: 'Old notes', url: 'https://claude.ai/project/p2' }] } },
    });
    const out = await s.run('claude_projects_sync');
    expect(s.remembered.map((p) => p.name)).toEqual(['novi', 'calc', 'portfolio']);
    const pf = s.notes.find((n) => n.title === 'Portfolio project');
    expect(pf.text).toMatch(/Folder: \/p\/Portfolio\nLast worked on in Claude Code: 2026-10-17 \(3 conversations\)\nAbout: Portfolio with a blog/);
    expect(out.note).toBe('I know 3 Claude Code projects now: 1 new (Portfolio). 1 has a name I already use (calc). On claude.ai you have 2 projects: Portfolio, Old notes. 1 is a folder on the laptop too (Portfolio); 1 is only on claude.ai (Old notes).');
    expect(out.added).toEqual(['Portfolio']);
  });

  // Every claude.ai project comes into Novi (user, 2026-10-18: "FlexR, MediKiosk AI, TraceBite… so I can
  // handle them with Novi from anywhere"): matched to a folder when one exists, else kept as claude.ai only.
  it('sync: every claude.ai project is remembered with its link, folder or not, each with a note', async () => {
    const s = setup({
      known: [{ name: 'tracebite', path: '/p/TraceBite' }],
      web: { list: { names: ['TraceBite', 'FlexR', 'MediKiosk AI'], projects: [
        { name: 'TraceBite', url: 'https://claude.ai/project/t' },
        { name: 'FlexR', url: 'https://claude.ai/project/f' },
        { name: 'MediKiosk AI', url: 'https://claude.ai/project/m' },
      ] } },
    });
    const out = await s.run('claude_projects_sync');
    expect(out.note).toMatch(/On claude\.ai you have 3 projects: TraceBite, FlexR, MediKiosk AI\. 1 is a folder on the laptop too \(TraceBite\); 2 are only on claude\.ai \(FlexR, MediKiosk AI\)\.$/);
    expect(s.notes.map((n) => n.title)).toEqual(['TraceBite project', 'FlexR project', 'MediKiosk AI project']);
    expect(s.notes[0].text).toBe('On claude.ai: https://claude.ai/project/t\nFolder: /p/TraceBite');
    expect(s.notes[1].text).toBe('On claude.ai: https://claude.ai/project/f\nNo folder on the laptop yet.');
    expect(s.runtime.claudeProjectNames()).toEqual(['TraceBite', 'FlexR', 'MediKiosk AI']);
    // A second sync doesn't write the same notes again, and making TraceBite again is refused.
    await s.run('claude_projects_sync');
    expect(s.notes).toHaveLength(3);
    expect((await s.run('claude_project_make', { project: 'tracebite' })).note).toBe('TraceBite is already on claude.ai: https://claude.ai/project/t');
  });

  it('sync: a folder Novi added that is only a container (Documents) is forgotten again; brief names get capitals', async () => {
    const s = setup({ known: [{ name: 'portfolio', path: '/p/Portfolio' }] });
    fs.writeFileSync(path.join(s.dataDir, 'claude-link.json'), JSON.stringify({ added: { 'ドキュメント': '/home/u/ドキュメント' } }));
    const s2 = setup({ known: [{ name: 'portfolio', path: '/p/Portfolio' }, { name: 'ドキュメント', path: '/home/u/ドキュメント' }], dataDir: s.dataDir });
    await s2.run('claude_projects_sync');
    expect(s2.remembered.map((p) => p.name)).toEqual(['portfolio']);
    expect(s2.recased).toEqual(['Portfolio brief']);
  });

  it('open: a claude.ai project on the device that asked (a link on the phone), any spelling', async () => {
    const s = setup({ web: { list: { names: ['MediKiosk AI'], projects: [{ name: 'MediKiosk AI', url: 'https://claude.ai/project/m' }] } } });
    await s.run('claude_projects_sync');
    expect((await s.run('claude_project_open', { project: 'medikiosk' })).note).toBe('Opened MediKiosk AI on claude.ai.');
    expect(s.opened).toEqual([['open_website', { url: 'https://claude.ai/project/m' }]]);
    expect((await s.run('claude_project_open', { project: 'nothing here' })).error).toMatch(/don't know a claude\.ai project called nothing here/);
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
    // Each project's own dot in Novi Memory, even when Chrome isn't there.
    expect(s.notes.filter((n) => /^Folder:/.test(n.text)).map((n) => [n.title, n.text])).toEqual([['shop project', 'Folder: /p/shop\nAbout: A shoe shop'], ['Portfolio project', 'Folder: /p/Portfolio']]);
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
    ['sync every project I have on Claude', { tool: 'claude_projects_sync', args: {} }],
    ['sync all my projects from Claude to Novi', { tool: 'claude_projects_sync', args: {} }],
    ['open TraceBite on claude.ai', { tool: 'claude_project_open', args: { project: 'TraceBite' } }],
    ['open my FlexR Claude project', { tool: 'claude_project_open', args: { project: 'FlexR' } }],
    ['open the MediKiosk AI project on Claude', { tool: 'claude_project_open', args: { project: 'MediKiosk AI' }, soft: true }],
    // soft: the agent sends a folder project to Claude Code instead.
    ['open portfolio in Claude', { tool: 'claude_project_open', args: { project: 'portfolio' }, soft: true }],
  ])('%s', (text, want) => {
    expect(claudeLinkCommand(text)).toEqual(want);
  });

  it.each(['tell Claude to add a blog to portfolio', 'open Claude', 'make a new project called shop', 'put the song on'])('not this: %s', (text) => {
    expect(claudeLinkCommand(text)).toBeNull();
  });
});

// "Link the FLEXR context file to my FlexR project" (live, 2026-10-18: the AI kept asking for the path,
// even after it was pasted) — understood without the AI.
describe('linking a folder to a project by voice', () => {
  it.each([
    ['link the FLEXR context file to my FLEXR project according to u', { project: 'FLEXR', name: 'FLEXR context' }],
    ['sync the flexr context folder to my flexr project', { project: 'flexr', name: 'flexr context' }],
    ['connect my robotics folder with the SIH project', { project: 'SIH', name: 'robotics' }],
    ['the folder for FlexR is "C:\\Users\\A\\OneDrive\\ドキュメント\\FLEXR context"', { project: 'FlexR', path: 'C:\\Users\\A\\OneDrive\\ドキュメント\\FLEXR context' }],
    ['link C:\\Users\\A\\Projects\\shop to my shop project', { project: 'shop', path: 'C:\\Users\\A\\Projects\\shop' }],
    ['"C:\\Users\\A\\OneDrive\\ドキュメント\\FLEXR context"', { path: 'C:\\Users\\A\\OneDrive\\ドキュメント\\FLEXR context' }],
    ['/home/a/projects/flexr', { path: '/home/a/projects/flexr' }],
  ])('%s', async (text, want) => {
    const { linkFolderCommand } = await import('../../server/brain/claudeLinkCommand.js');
    expect(linkFolderCommand(text)).toEqual(want);
  });
  it.each(['add portfolio to my Claude projects', 'add milk to my shopping note', 'link me the youtube video', 'connect to wifi', 'open in my folder on laptop'])('not this: %s', async (text) => {
    const { linkFolderCommand } = await import('../../server/brain/claudeLinkCommand.js');
    expect(linkFolderCommand(text)).toBeNull();
  });
});

// Live 2026-10-20: FLEXR (claude.ai-only) was linked to its folder, but Novi Memory showed no files —
// its note still said "No folder on the laptop yet", and the map takes a project's dots from `Folder:`.
describe('a linked folder reaches the project note', () => {
  it('sync writes the folder into the note of every project that has one but whose note lacks it, once', async () => {
    const s = setup({ known: [{ name: 'flexr', path: '/p/FLEXR context' }], web: { list: { names: ['FLEXR'], projects: [{ name: 'FLEXR', url: 'https://claude.ai/project/f' }] } } });
    await s.run('claude_projects_sync');
    const folderNotes = s.notes.filter((n) => /^Folder: /m.test(n.text));
    expect(folderNotes).toHaveLength(1);
    expect(folderNotes[0]).toMatchObject({ title: 'FLEXR project', text: expect.stringMatching(/^Folder: \/p\/FLEXR context$/m) });
    await s.run('claude_projects_sync');
    expect(s.notes.filter((n) => /^Folder: /m.test(n.text))).toHaveLength(1);
  });
});

// Live 2026-10-20 (phone): "tell me till date progress of that flexr project on claude" → the AI asked
// "which project?". Now one tool gathers what Novi knows and answers.
describe('project progress', () => {
  it.each([
    ['tell me till date progress of that flexr project on claude', 'flexr'],
    ['what is the progress of my TraceBites project', 'TraceBites'],
    ['status of portfolio', 'portfolio'],
    ["what's next for FLEXR", 'FLEXR'],
    ['where did I leave off on medikiiosk', 'medikiiosk'],
    ['flexr ka progress kya hai', 'flexr'],
  ])('%s', async (text, project) => {
    const { projectStatusCommand } = await import('../../server/brain/claudeLinkCommand.js');
    expect(projectStatusCommand(text)).toEqual({ tool: 'project_status', args: { project } });
  });
  it.each(["what's the progress", 'progress kya hai', 'status of my order', 'what is the progress of it', 'tell me the weather update'])('not this: %s', async (text) => {
    const { projectStatusCommand } = await import('../../server/brain/claudeLinkCommand.js');
    expect(projectStatusCommand(text)).toBeNull();
  });

  function withStatus({ known = [], webProjects = [], chats = ['Workout API', 'Login screen'], next = 'Last commit: added login. Next: payments.' } = {}) {
    const s = setup({ known, web: { list: { names: webProjects.map((p) => p.name), projects: webProjects }, info: { chats } } });
    s.runtime.callTool = async (name, args) => (name === 'project_next' ? { text: `${args.project}: ${next}` } : { opened: true });
    s.runtime.wikiRead = (t) => (/brief/i.test(t) ? 'Goal: a fitness app with workout plans.' : null);
    const asked = [];
    s.runtime.privateComplete = async (p) => { asked.push(p); return 'FLEXR: login is done, payments are next.'; };
    const said = [];
    s.runtime.say = (t) => said.push(t);
    return { ...s, asked, said };
  }

  it('a claude.ai-only project: its chats and brief go to the private AI, the answer is said', async () => {
    const s = withStatus({ webProjects: [{ name: 'FLEXR', url: 'https://claude.ai/project/f' }] });
    await s.run('claude_projects_sync');
    const out = await s.run('project_status', { project: 'flexr' });
    expect(out.note).toBe('Checking FLEXR…');
    await s.jobs.at(-1);
    expect(s.asked[0]).toMatch(/Workout API/);
    expect(s.asked[0]).toMatch(/Goal: a fitness app/);
    expect(s.asked[0]).toMatch(/No folder on the laptop/);
    expect(s.said.at(-1)).toBe('FLEXR: login is done, payments are next.');
  });

  it('a project with a folder also gets its latest work from project_next', async () => {
    const s = withStatus({ known: [{ name: 'portfolio', path: '/p/Portfolio' }] });
    await s.run('project_status', { project: 'portfolio' });
    await s.jobs.at(-1);
    expect(s.asked[0]).toMatch(/Last commit: added login/);
  });

  it('the private AI busy → the facts themselves, never silence', async () => {
    const s = withStatus({ webProjects: [{ name: 'FLEXR', url: 'https://claude.ai/project/f' }] });
    s.runtime.privateComplete = async () => { throw new Error('busy'); };
    await s.run('claude_projects_sync');
    await s.run('project_status', { project: 'FLEXR' });
    await s.jobs.at(-1);
    expect(s.said.at(-1)).toMatch(/^FLEXR: on claude\.ai, recent chats: Workout API, Login screen\./);
  });

  it('an unknown project says so and names the close ones', async () => {
    const s = withStatus({ webProjects: [{ name: 'FLEXR', url: 'https://claude.ai/project/f' }] });
    await s.run('claude_projects_sync');
    expect((await s.run('project_status', { project: 'lexa' })).error).toBe(`I don't know a project called lexa. Your projects: FLEXR. If it's new on claude.ai, say "sync my Claude projects".`);
  });
});

describe('claude.ai projects without Chrome', () => {
  it('a project known only from its Novi Memory note is still found (no sync, no Chrome)', async () => {
    const s = setup({ connected: false });
    s.runtime.wikiNotes = () => [{ title: 'FLEXR project', text: 'On claude.ai: https://claude.ai/project/f\nNo folder on the laptop yet.' }];
    s.runtime.say = () => {};
    s.runtime.privateComplete = async () => 'ok';
    expect((await s.run('project_status', { project: 'flexr' })).note).toBe('Checking FLEXR…');
    expect((await s.run('claude_project_open', { project: 'flexr' })).note).toBe('Opened FLEXR on claude.ai.');
  });
});
