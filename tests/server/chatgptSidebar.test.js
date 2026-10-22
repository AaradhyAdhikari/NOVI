import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createSync } from '../../plugins/chatgpt-plan/index.js';
import { createVault } from '../../plugins/wiki/vault.js';
import { buildGraph } from '../../plugins/wiki/graph.js';

// The ChatGPT dot holds the user's ChatGPT projects and pinned chats (user, 2026-10-20: "only if I add
// any pinned chat it gets updated, same for the project"), like the Claude dot holds claude.ai projects.
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-gptside-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const readExt = (f) => fs.readFileSync(new URL(`../../extension/${f}`, import.meta.url), 'utf8');

describe('extension groups: links under the sidebar heading above them', () => {
  function sidebar(rows) {
    const els = rows.map(([kind, text, href]) => {
      const e = { kind, innerText: text, textContent: text, children: [], attrs: href ? { href, 'aria-label': text } : {} };
      e.getAttribute = (k) => e.attrs[k] ?? null;
      e.matches = (sel) => sel === 'a[href]' && kind === 'a';
      e.closest = (sel) => (sel === 'a[href]' && kind === 'a' ? e : null);
      e.querySelector = () => null;
      e.getClientRects = () => [1];
      return e;
    });
    const nav = { querySelectorAll: () => els };
    const document = { title: 'T', body: { innerText: '' }, querySelectorAll: () => [], querySelector: (s) => (s === 'nav' ? nav : null) };
    const window = {};
    vm.runInNewContext(readExt('page.js'), { window, document, location: { href: 'https://chatgpt.com/' }, getComputedStyle: () => ({ visibility: 'visible' }), Event: class {} });
    return window.__novi;
  }

  it('collects each heading\'s links until the next heading', () => {
    const novi = sidebar([
      ['h', 'Projects'], ['a', 'NOVI', '/g/g-p-1-novi/project'], ['a', 'FlexR', '/g/g-p-2-flexr/project'],
      ['h', 'Pinned'], ['a', 'Brain plan', '/c/aaa'],
      ['h', 'Recents'], ['a', 'Diet', '/c/bbb'],
    ]);
    expect(novi.groups({ root: 'nav', headings: ['^projects$', '^pinned', '^(recents|chats)$'] })).toEqual({ groups: [
      { heading: 'Projects', items: [{ text: 'NOVI', href: '/g/g-p-1-novi/project' }, { text: 'FlexR', href: '/g/g-p-2-flexr/project' }] },
      { heading: 'Pinned', items: [{ text: 'Brain plan', href: '/c/aaa' }] },
      { heading: 'Recents', items: [{ text: 'Diet', href: '/c/bbb' }] },
    ] });
    expect(readExt('background.js')).toMatch(/'groups'/);
    expect(JSON.parse(readExt('manifest.json')).version).toBe('1.8.3');
  });
});

describe('sync: ChatGPT projects and pinned chats become notes', () => {
  function sideSetup(groupsSeq, state = { title: 'NOVI' }) {
    const notes = [];
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify(state));
    let i = 0;
    const request = async (cmd, args) => {
      if (cmd === 'tabs') return { tabs: [{ id: 7 }] };
      if (cmd === 'open') return { tabId: 7, url: args.url };
      if (cmd === 'waitFor') return { found: true };
      if (cmd === 'groups') return { groups: groupsSeq[Math.min(i++, groupsSeq.length - 1)] };
      if (cmd === 'textsOf') return { items: [] };
      return {};
    };
    const sync = createSync({ dir, guideFile: 'none', now: () => new Date('2026-10-20T08:00:00Z'), runtime: { browserRequest: request, browserStatus: () => ({ connected: true }), wikiWrite: (n) => notes.push(n) } });
    return { sync, notes, dir };
  }
  const side = (projects, pinned) => [
    { heading: 'Projects', items: projects.map(([text, href]) => ({ text, href })) },
    ...(pinned ? [{ heading: 'Pinned', items: pinned.map(([text, href]) => ({ text, href })) }] : []),
    { heading: 'Recents', items: [{ text: 'Diet', href: '/c/zzz' }] },
  ];

  it('notes each project and pinned chat once; a new pin or an unpin is noted at the next check', async () => {
    const s = sideSetup([
      side([['NOVI', '/g/g-p-1-novi/project'], ['See more', '/projects']], [['Brain plan', '/c/aaa']]),
      side([['NOVI', '/g/g-p-1-novi/project']], [['Brain plan', '/c/aaa'], ['Diet', '/c/bbb']]),
      side([['NOVI', '/g/g-p-1-novi/project']], null),
    ]);
    const first = await s.sync();
    expect(s.notes).toEqual([
      { title: 'NOVI project', text: 'On ChatGPT: https://chatgpt.com/g/g-p-1-novi/project' },
      { title: 'Brain plan (pinned chat)', text: 'Pinned on ChatGPT: https://chatgpt.com/c/aaa' },
    ]);
    expect(first.note).toMatch(/On ChatGPT: 1 project \(NOVI\) and 1 pinned chat \(Brain plan\)/);
    await s.sync();
    expect(s.notes.slice(2)).toEqual([{ title: 'Diet (pinned chat)', text: 'Pinned on ChatGPT: https://chatgpt.com/c/bbb' }]);
    await s.sync(); // nothing pinned any more: the Pinned heading is gone, Recents still shows
    expect(s.notes.slice(3)).toEqual([
      { title: 'Brain plan (pinned chat)', text: 'Unpinned on ChatGPT: 2026-10-20' },
      { title: 'Diet (pinned chat)', text: 'Unpinned on ChatGPT: 2026-10-20' },
    ]);
  });

  it('saving the planning chat keeps the projects and pinned chats just noted', async () => {
    const s = sideSetup([side([['NOVI', '/g/g-p-1-novi/project']], [['Brain plan', '/c/aaa']])], { title: 'NOVI', url: 'https://chatgpt.com/c/plan' });
    await s.sync();
    const st = JSON.parse(fs.readFileSync(path.join(s.dir, 'chat.json'), 'utf8'));
    expect(st.projects).toEqual({ 'https://chatgpt.com/g/g-p-1-novi/project': 'NOVI' });
    expect(st.pinned).toEqual({ 'https://chatgpt.com/c/aaa': 'Brain plan' });
    expect(st.lastSync).toBeTruthy();
  });

  // Live 2026-10-20: the share link had no sidebar and timed out in a hidden tab. Now: chatgpt.com first,
  // and the pinned chat named like the planning chat ("NOVI") becomes its address.
  it('no chat address: the pinned "NOVI" chat becomes the planning chat, read at once', async () => {
    const notes = [];
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ title: 'NOVI', share: 'https://chatgpt.com/share/x' }));
    const opened = [];
    const request = async (cmd, args) => {
      if (cmd === 'open') { opened.push(args.url); return { tabId: 7 }; }
      if (cmd === 'tabs') return { tabs: [{ id: 7 }] };
      if (cmd === 'waitFor') return { found: true };
      if (cmd === 'groups') return { groups: side([], [['NOVI', '/c/novi-1'], ['Placement', '/c/p']]) };
      if (cmd === 'textsOf') return { items: [{ text: 'Plan it', attrs: { 'data-user-message-bubble': 'true' } }] };
      return {};
    };
    const sync = createSync({ dir, guideFile: 'none', runtime: { browserRequest: request, browserStatus: () => ({ connected: true }), wikiWrite: (n) => notes.push(n) } });
    const out = await sync();
    expect(opened).toEqual(['https://chatgpt.com/', 'https://chatgpt.com/c/novi-1']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8')).url).toBe('https://chatgpt.com/c/novi-1');
    expect(fs.readFileSync(path.join(dir, 'NOVI.md'), 'utf8')).toContain('Plan it');
    expect(out.note).toMatch(/2 pinned chats \(NOVI, Placement\)/);
  });

  // Live 2026-10-20: in the user's Chrome the sidebar was closed — 0 chat links, only "Hey, Aaradhy…".
  it('a closed sidebar is opened to read it, then closed again', async () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ title: 'NOVI' }));
    let open = false;
    const clicks = [];
    const request = async (cmd, args) => {
      if (cmd === 'open') return { tabId: 7 };
      if (cmd === 'waitFor') return { found: true };
      if (cmd === 'clickSel') { clicks.push(args.selector); open = /Open sidebar/.test(args.selector) ? true : /Close sidebar/.test(args.selector) ? false : open; return {}; }
      if (cmd === 'groups') return { groups: open ? side([], [['Placement', '/c/p']]) : [] };
      if (cmd === 'query') return { texts: [] };
      return {};
    };
    const out = await createSync({ dir, guideFile: 'none', runtime: { browserRequest: request, browserStatus: () => ({ connected: true }), wikiWrite: () => {} } })();
    expect(out.note).toMatch(/1 pinned chat \(Placement\)/);
    expect(clicks).toHaveLength(2);
    expect(clicks[0]).toMatch(/Open sidebar/);
    expect(clicks[1]).toMatch(/Close sidebar/);
  });

  // 2026-10-22, user: "it opens too many tabs… do all this work in background and not by using my screen".
  it('its own tab in Novi\'s window (one, kept by the extension); a wait that times out is waited once more, never brought forward', async () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ title: 'NOVI' }));
    let waits = 0;
    const calls = [];
    const request = async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'open') { expect(args).toMatchObject({ slot: 'chatgpt-plan', background: true }); expect(args.newTab).toBe(true); return { tabId: 7 }; }
      if (cmd === 'waitFor') { waits += 1; if (waits === 1) throw new Error('timeout'); return { found: true }; }
      if (cmd === 'groups') return { groups: side([['NOVI', '/g/g-p-1/project']], null) };
      return {};
    };
    const out = await createSync({ dir, guideFile: 'none', runtime: { browserRequest: request, browserStatus: () => ({ connected: true }), wikiWrite: () => {} } })();
    expect(calls).not.toContain('switch');
    expect(out.note).toMatch(/1 project \(NOVI\)/);
  });

  it('a sidebar that did not show (no headings) changes nothing; no chat address = sidebar only, no error', async () => {
    const s = sideSetup([side([['NOVI', '/g/g-p-1-novi/project']], [['Brain plan', '/c/aaa']]), []]);
    expect((await s.sync()).error).toBeUndefined();
    await s.sync();
    expect(s.notes).toHaveLength(2);
  });
});

describe('graph: the ChatGPT dot', () => {
  function vaultWith(files) {
    const vault = createVault(mkdir());
    vault.ensure();
    for (const [rel, text] of Object.entries(files)) vault.write(rel, text);
    return vault;
  }

  it('projects on ChatGPT (also on claude.ai: both dots) and pinned chats until unpinned', () => {
    const g = buildGraph(vaultWith({
      'Notes/NOVI project.md': '# NOVI project\n\nOn claude.ai: https://claude.ai/project/n\n\nOn ChatGPT: https://chatgpt.com/g/g-p-1/project',
      'Notes/FlexR project.md': '# FlexR project\n\nOn ChatGPT: https://chatgpt.com/g/g-p-2/project',
      'Notes/Brain plan (pinned chat).md': '# Brain plan (pinned chat)\n\nPinned on ChatGPT: https://chatgpt.com/c/aaa',
      'Notes/Diet (pinned chat).md': '# Diet (pinned chat)\n\nPinned on ChatGPT: https://chatgpt.com/c/bbb\n\nUnpinned on ChatGPT: 2026-10-20',
    }));
    const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
    expect(g.nodes.find((n) => n.id === 'ChatGPT').excerpt).toBe('On ChatGPT: 2 projects (FlexR, NOVI) and 1 pinned chat (Brain plan). Claude builds them.');
    expect(has('Notes/NOVI project.md', 'ChatGPT')).toBe(true);
    expect(has('Notes/NOVI project.md', 'Claude')).toBe(true);
    expect(has('Notes/FlexR project.md', 'ChatGPT')).toBe(true);
    expect(has('Notes/FlexR project.md', 'Novi Memory.md')).toBe(false);
    expect(has('Notes/Brain plan (pinned chat).md', 'ChatGPT')).toBe(true);
    expect(has('Notes/Diet (pinned chat).md', 'ChatGPT')).toBe(false);
    // They work together (user, 2026-10-20): a direct line between the two dots.
    expect(has('ChatGPT', 'Claude')).toBe(true);
  });

  it('ChatGPT plans, Claude builds: the Claude dot is there (and linked) even without claude.ai projects', () => {
    const g = buildGraph(vaultWith({ 'Notes/ChatGPT plan.md': '# ChatGPT plan\n\nx' }));
    const has = (a, b) => g.links.some((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
    expect(g.nodes.find((n) => n.id === 'Claude')).toMatchObject({ title: 'Claude', excerpt: 'Claude builds what ChatGPT plans.' });
    expect(has('ChatGPT', 'Claude')).toBe(true);
    expect(has('Claude', 'Novi Memory.md')).toBe(true);
    // The plan is what Claude builds (user, 2026-10-20): it touches both dots.
    expect(has('Notes/ChatGPT plan.md', 'ChatGPT')).toBe(true);
    expect(has('Notes/ChatGPT plan.md', 'Claude')).toBe(true);
  });
});
