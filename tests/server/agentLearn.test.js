import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { answerAfter, siteAdapter, teamAddCommand } from '../../plugins/agents/learned.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createAgentsPlugin } from '../../plugins/agents/index.js';

// New AIs join by themselves (2026-11-12, user: "what if I added Gemini it should automatically get added…
// make Novi that smart… don't make them rule based… it should be done for all and everything"). No site
// list: a chat-shaped page the user uses is noticed, learned in general terms (its box, Enter, the answer
// under the message), tested with one tiny question, then the user is asked. A member with no record starts last.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-learn-'));

describe('the answer is what appeared under your message', () => {
  it('text after the last copy of the prompt, minus the page around it', () => {
    const before = 'New chat\nHistory\nAsk anything';
    const after = 'New chat\nHistory\nReply with READY\nREADY\nRegenerate\nAsk anything';
    expect(answerAfter(before, after, 'Reply with READY')).toMatch(/^READY/);
  });
  it('no prompt on the page: the new text that was not there before', () => {
    expect(answerAfter('Home\nMenu', 'Home\nMenu\nThe answer is 42.', 'a question the page cut')).toBe('The answer is 42.');
  });
});

describe('a learned site as a team member', () => {
  it('opens it in Novi\'s own window, types, sends, waits until the answer stops growing, reads it', async () => {
    const calls = [];
    let reads = 0;
    const page = ['Ask anything', 'Ask anything\nhello\nThe', 'Ask anything\nhello\nThe answer', 'Ask anything\nhello\nThe answer', 'Ask anything\nhello\nThe answer'];
    const rt = {
      browserStatus: () => ({ connected: true }),
      browserRequest: async (cmd, args) => {
        calls.push(cmd);
        if (cmd === 'open') return { tabId: 9 };
        if (cmd === 'chatAsk') return { sent: true };
        if (cmd === 'chatRead') { const text = page[Math.min(reads, page.length - 1)]; reads += 1; return { text, busy: reads < 3 }; }
        return {};
      },
    };
    const a = siteAdapter({ host: 'brandnew.ai', url: 'https://brandnew.ai/chat', name: 'Brandnew' }, { rt, sleep: async () => {} });
    expect(a.roles).toEqual(['research', 'plan', 'review']);
    expect(await a.available()).toMatchObject({ ok: true });
    const out = await a.run('hello');
    expect(out).toMatchObject({ ok: true, output: 'The answer' });
    expect(calls[0]).toBe('open');
  });
  it('the page never takes the message: a failure that says so', async () => {
    const rt = { browserStatus: () => ({ connected: true }), browserRequest: async (cmd) => (cmd === 'open' ? { tabId: 1 } : cmd === 'chatAsk' ? { sent: false, why: 'no message box' } : { text: '' }) };
    const out = await siteAdapter({ host: 'x.ai', url: 'https://x.ai', name: 'X' }, { rt, sleep: async () => {} }).run('hi');
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toMatch(/message box/);
  });
});

describe('the words', () => {
  it('"add X to the team" / "make X part of the team"', () => {
    expect(teamAddCommand('add brandnew ai to the team')).toEqual({ tool: 'team_add', args: { name: 'brandnew ai' } });
    expect(teamAddCommand('add https://brandnew.ai/chat to my team')).toEqual({ tool: 'team_add', args: { name: 'https://brandnew.ai/chat' } });
    expect(teamAddCommand('make kimi part of the team')).toEqual({ tool: 'team_add', args: { name: 'kimi' } });
    expect(teamAddCommand('add dark mode to the team page')).toBe(null);
  });
});

describe('the plugin notices, tests and asks', () => {
  function setup({ answer = { allow: true }, shape = { chat: true }, readyText = 'READY' }) {
    const dir = tmp();
    const tasks = new EventEmitter();
    tasks.status = () => ({ active: false });
    const cards = [];
    const said = [];
    const tabs = [
      { id: 1, title: 'ChatGPT', url: 'https://chatgpt.com/c/1', lastAccessed: 3 },
      { id: 2, title: 'Brandnew AI', url: 'https://brandnew.ai/chat/7', lastAccessed: 9 },
      { id: 3, title: 'Gmail', url: 'https://mail.google.com/', lastAccessed: 8 },
    ];
    let reads = 0;
    const rt = {
      tasks, dataDir: dir, say: (t) => said.push(t), notice: () => {}, logger: { warn() {}, info() {} },
      projects: { list: () => [] }, browserStatus: () => ({ connected: true }),
      browserRequest: async (cmd, args) => {
        if (cmd === 'tabs') return { tabs };
        if (cmd === 'chatShape') return args.tabId === 2 ? shape : { chat: false };
        if (cmd === 'open') return { tabId: 50 };
        if (cmd === 'chatAsk') return { sent: true };
        if (cmd === 'chatRead') { reads += 1; return { text: `Ask\nReply with just the word READY.\n${reads > 1 ? readyText : ''}`, busy: false }; }
        return {};
      },
      ask: async (card) => { cards.push(card); return answer; },
    };
    const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
    host.register(createAgentsPlugin({ exec: async () => { throw new Error('none'); }, learnSleep: async () => {} }));
    return { host, dir, cards, said, rt };
  }
  it('a chat site you use that is not on the team: tested, one card, yes → it joins and stays after a restart', async () => {
    const { host, dir, cards, said } = setup({});
    const out = await host.get('team_discover').run({});
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toMatch(/Add Brandnew AI to the team\?/);
    expect(out.note).toMatch(/Brandnew AI joined the team/);
    expect(said.join(' ')).not.toMatch(/Gmail/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'learned.json'), 'utf8')).members[0]).toMatchObject({ host: 'brandnew.ai' });
    // A fresh Novi on the same data folder has it on the team.
    const fresh = new PluginHost({ runtime: { ...setup({}).rt, dataDir: dir }, env: {}, logger: { warn() {}, info() {} } });
    fresh.register(createAgentsPlugin({ exec: async () => { throw new Error('none'); }, learnSleep: async () => {} }));
    expect((await fresh.get('project_agents').run({})).note).toMatch(/Brandnew AI: research, plan, review/);
  });
  it('no → never asked about that site again', async () => {
    const { host, cards } = setup({ answer: { allow: false } });
    await host.get('team_discover').run({});
    await host.get('team_discover').run({});
    expect(cards).toHaveLength(1);
  });
  it('a site that fails the test is not offered', async () => {
    const { host, cards } = setup({ readyText: 'something else' });
    const out = await host.get('team_discover').run({});
    expect(cards).toHaveLength(0);
    expect(out.note).toMatch(/nothing new|couldn't learn/i);
  });
  it('"add X to the team": the tab of that name, same test and card', async () => {
    const { host, cards } = setup({});
    const out = await host.get('team_add').run({ name: 'brandnew' });
    expect(cards[0].title).toMatch(/Brandnew AI/);
    expect(out.note).toMatch(/joined/);
  });
});
