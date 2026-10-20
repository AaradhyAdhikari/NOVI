import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toMarkdown, newSince, messageKey, crosscheckPrompt, chatKind } from '../../plugins/chatgpt-plan/chat.js';
import { createSync } from '../../plugins/chatgpt-plan/index.js';

// The user's planning chat (2026-10-20): "plan on ChatGPT, then Claude implements it". Novi keeps a
// private copy of the chat in chatgpt/ and cross-checks every new ChatGPT answer against CLAUDE.md.
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-gpt-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('chat helpers', () => {
  it('knows a chat address from a share link', () => {
    expect(chatKind('https://chatgpt.com/c/6ad7-12')).toBe('chat');
    expect(chatKind('https://chatgpt.com/g/g-abc/c/6ad7-12')).toBe('chat');
    expect(chatKind('https://chatgpt.com/share/6ad7129c-3834')).toBe('share');
    expect(chatKind('https://example.com/c/1')).toBe(null);
  });

  it('writes the chat as Markdown, numbered, with who said it', () => {
    const md = toMarkdown({ title: 'NOVI', source: 'https://chatgpt.com/c/1', syncedAt: '2026-10-20 13:00', messages: [{ role: 'you', text: 'Plan the brain' }, { role: 'chatgpt', text: '1. Index\n2. Search' }] });
    expect(md).toContain('# ChatGPT: NOVI');
    expect(md).toContain('Source: https://chatgpt.com/c/1');
    expect(md).toMatch(/## 1\. You\n\nPlan the brain/);
    expect(md).toMatch(/## 2\. ChatGPT\n\n1\. Index\n2\. Search/);
  });

  it('finds the messages not seen before', () => {
    const a = { role: 'you', text: 'a' };
    const b = { role: 'chatgpt', text: 'b' };
    expect(newSince([messageKey(a)], [a, b])).toEqual([b]);
    expect(newSince([], [a])).toEqual([a]);
  });

  it('the cross-check prompt carries the new messages and the project guide, cut to size', () => {
    const p = crosscheckPrompt({ fresh: [{ role: 'chatgpt', text: 'Use BHASHINI for speech' }], guide: '## Hard rules\n- no paid APIs\n' + 'x'.repeat(100_000) });
    expect(p).toContain('Use BHASHINI for speech');
    expect(p).toContain('no paid APIs');
    expect(p).toMatch(/Done|Not built/);
    expect(p.length).toBeLessThan(90_000);
  });
});

function fakeChrome({ items, connected = true, loads = true, login = false } = {}) {
  const calls = [];
  const request = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'tabs') return { tabs: [{ id: 7 }] };
    if (cmd === 'open') return { tabId: 7 };
    if (cmd === 'waitFor') return { found: loads };
    if (cmd === 'has') return { found: login };
    if (cmd === 'switch') return {};
    if (cmd === 'textsOf') return items === undefined ? {} : { items };
    return {};
  };
  return { calls, request, status: () => ({ connected }) };
}

function setup({ chrome = fakeChrome({ items: [{ text: 'Plan the brain', attrs: { 'data-user-message-bubble': 'true' } }, { text: 'Step 1: index files', attrs: { 'data-markdown-text-style': 'assistant-message' } }] }), answer = '- [Done] index files — plugins/brain', state = { url: 'https://chatgpt.com/c/abc', title: 'NOVI' } } = {}) {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify(state));
  const guide = path.join(mkdir(), 'CLAUDE.md');
  fs.writeFileSync(guide, '## Hard rules\n- Claude only for coding\n');
  const asked = [];
  const notes = [];
  const sync = createSync({
    dir, guideFile: guide, now: () => new Date('2026-10-20T07:30:00Z'),
    runtime: {
      browserRequest: chrome.request, browserStatus: chrome.status,
      complete: async (text, opts) => { asked.push({ text, opts }); return answer; },
      wikiWrite: (n) => notes.push(n),
    },
  });
  return { dir, sync, asked, notes, chrome, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8') };
}

describe('syncing the ChatGPT chat', () => {
  it('saves the whole chat, cross-checks the new ChatGPT answer with Gemini, and notes it in Novi Memory', async () => {
    const s = setup();
    const out = await s.sync();
    expect(out.error).toBeUndefined();
    expect(s.read('NOVI.md')).toMatch(/## 2\. ChatGPT\n\nStep 1: index files/);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0].opts).toEqual({ prefer: 'gemini' });
    expect(s.asked[0].text).toContain('Step 1: index files');
    expect(s.asked[0].text).toContain('Claude only for coding');
    expect(s.read('crosscheck.md')).toContain('[Done] index files');
    expect(s.notes[0].title).toBe('ChatGPT plan');
    expect(out.note).toMatch(/2 messages.*cross-checked/i);
    expect(s.chrome.calls.find((c) => c.cmd === 'open').args).toMatchObject({ url: 'https://chatgpt.com/c/abc', background: true });
  });

  it('nothing new: no AI call and no new cross-check', async () => {
    const s = setup();
    await s.sync();
    const again = await s.sync();
    expect(s.asked).toHaveLength(1);
    expect(again.note).toMatch(/nothing new/i);
    expect(s.read('crosscheck.md').match(/^## /gm)).toHaveLength(1);
  });

  it('only my own new message: saved, but nothing to cross-check yet', async () => {
    const s = setup({ chrome: fakeChrome({ items: [{ text: 'What next?', attrs: { 'data-user-message-bubble': 'true' } }] }) });
    const out = await s.sync();
    expect(s.asked).toHaveLength(0);
    expect(s.read('NOVI.md')).toContain('What next?');
    expect(out.note).toMatch(/no new answer from ChatGPT/i);
  });

  it('says plainly what is missing: chat address, Chrome, login, an old extension', async () => {
    expect((await setup({ state: {} }).sync()).error).toMatch(/address of your ChatGPT chat/);
    expect((await setup({ chrome: fakeChrome({ connected: false }) }).sync()).error).toMatch(/Chrome isn't connected/);
    expect((await setup({ chrome: fakeChrome({ loads: false, login: true }) }).sync()).error).toMatch(/Log in to ChatGPT in Chrome/);
    expect((await setup({ chrome: fakeChrome({ items: undefined }) }).sync()).error).toMatch(/Reload the Novi extension/);
  });

  it('a failed cross-check still saves the chat and says so', async () => {
    const broken = setup();
    let busy = true;
    const sync = createSync({ dir: broken.dir, guideFile: path.join(broken.dir, 'none.md'), runtime: { browserRequest: fakeChrome({ items: [{ text: 'Do X', attrs: { 'data-markdown-text-style': 'assistant-message' } }] }).request, browserStatus: () => ({ connected: true }), complete: async () => { if (busy) throw new Error('busy'); return '- [Not built] X'; } } });
    const out = await sync();
    expect(broken.read('NOVI.md')).toContain('Do X');
    expect(out.note).toMatch(/couldn't cross-check/i);
    busy = false; // the next check catches up
    expect((await sync()).note).toMatch(/cross-checked/);
    expect(broken.read('crosscheck.md')).toContain('[Not built] X');
  });
});

describe('ChatGPT page layouts (live 2026-10-20: the role attribute was gone, the sync timed out)', () => {
  it('reads the old layout (data-message-author-role) too', async () => {
    const s = setup({ chrome: fakeChrome({ items: [{ text: 'Old question', attrs: { 'data-message-author-role': 'user' } }, { text: 'Old answer', attrs: { 'data-message-author-role': 'assistant' } }] }) });
    await s.sync();
    expect(s.read('NOVI.md')).toMatch(/## 1\. You\n\nOld question[\s\S]*## 2\. ChatGPT\n\nOld answer/);
  });

  it('an extension that was not reloaded (no attrs back) is told to reload', async () => {
    expect((await setup({ chrome: fakeChrome({ items: [{ text: 'x', attr: null }] }) }).sync()).error).toMatch(/Reload the Novi extension.*1\.6\.0/);
  });

  it('a Chrome timeout is said plainly', async () => {
    const s = setup();
    const sync = createSync({ dir: s.dir, guideFile: 'none', runtime: { browserRequest: async () => { throw new Error('timeout'); }, browserStatus: () => ({ connected: true }) } });
    expect((await sync()).error).toMatch(/Chrome didn't answer in time/);
  });
});
