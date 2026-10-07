import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createMemoryPlugin } from '../../plugins/memory/index.js';

let dataDir;
let clock;
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-ltm-')); clock = new Date('2026-10-07T10:00:00'); });
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function setup() {
  const host = new PluginHost({ runtime: { dataDir }, env: {}, logger: { warn() {}, log() {} } });
  expect(host.register(createMemoryPlugin({ now: () => clock }))).toBe(true);
  const run = (name, params = {}) => host.get(name).run(params);
  return { host, run };
}

describe('long-term memory: facts', () => {
  it('remembers a fact, privately', async () => {
    const { run } = setup();
    const out = await run('memory_remember', { fact: "Mom's birthday is 12 March." });
    expect(out.text).toMatch(/remember/i);
    expect(out.sensitive).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'long-term-memory', 'facts.json'), 'utf8'));
    expect(saved.map((f) => f.text)).toEqual(["Mom's birthday is 12 March."]);
  });

  it('updates instead of duplicating a fact about the same thing', async () => {
    const { run } = setup();
    await run('memory_remember', { fact: 'My favourite editor is VS Code.' });
    await run('memory_remember', { fact: 'My favourite editor is Cursor.' });
    const list = await run('memory_list');
    expect(list.facts.map((f) => f.text)).toEqual(['My favourite editor is Cursor.']);
  });

  it('recalls the facts that match a question', async () => {
    const { run } = setup();
    await run('memory_remember', { fact: "Mom's birthday is 12 March." });
    await run('memory_remember', { fact: 'I prefer short spoken answers.' });
    await run('memory_remember', { fact: 'My college is MIT-WPU in Pune.' });
    const out = await run('memory_recall', { query: 'when is mom birthday' });
    expect(out.facts[0].text).toBe("Mom's birthday is 12 March.");
    expect(out.facts.map((f) => f.text)).not.toContain('I prefer short spoken answers.');
    expect(out.sensitive).toBe(true);
  });

  it('asks for approval before forgetting, and shows what will be forgotten', async () => {
    const { host, run } = setup();
    await run('memory_remember', { fact: "Mom's birthday is 12 March." });
    const gate = await host.get('memory_forget').gate({ query: 'mom birthday' });
    expect(gate.approval).toMatchObject({ tier: 'medium', title: 'Forget a memory' });
    expect(gate.approval.detail).toContain("Mom's birthday is 12 March.");
    const out = await run('memory_forget', { query: 'mom birthday' });
    expect(out.text).toMatch(/Forgot/);
    expect((await run('memory_list')).facts).toEqual([]);
  });

  it('says so when there is nothing to forget', async () => {
    const { run } = setup();
    expect((await run('memory_forget', { query: 'dentist' })).text).toMatch(/don't have a memory/);
  });
});

describe('long-term memory: prompt context', () => {
  it('adds guidance, and the relevant memories marked private', async () => {
    const { host, run } = setup();
    await run('memory_remember', { fact: "Mom's birthday is 12 March." });
    const ctx = await host.promptContext({ prompt: "What should I get mom for her birthday?", messages: [] });
    expect(ctx.system).toMatch(/memory_remember/);
    expect(ctx.context).toMatch(/Mom's birthday is 12 March/);
    expect(ctx.sensitive).toBe(true);
  });

  it('adds no context (and stays non-private) when nothing is remembered', async () => {
    const { host } = setup();
    const ctx = await host.promptContext({ prompt: 'hi', messages: [] });
    expect(ctx.context).toBe('');
    expect(ctx.sensitive).toBe(false);
  });

  it('includes only matching memories once there are many', async () => {
    const { host, run } = setup();
    for (let i = 0; i < 30; i++) await run('memory_remember', { fact: `Project note number ${i} about topic${i}.` });
    await run('memory_remember', { fact: 'My dentist is Dr. Shah.' });
    const ctx = await host.promptContext({ prompt: 'who is my dentist', messages: [] });
    expect(ctx.context).toMatch(/Dr\. Shah/);
    expect(ctx.context).not.toMatch(/topic17/);
  });
});

describe('long-term memory: conversation history', () => {
  it('logs each exchange by day and answers "what did I ask yesterday"', async () => {
    const { host, run } = setup();
    clock = new Date('2026-10-06T21:30:00');
    await host.agentEnd({ messages: [{ role: 'user', content: "What's the weather in Pune?" }, { role: 'assistant', content: '23 degrees and clear.' }], success: true });
    clock = new Date('2026-10-07T09:00:00');
    await host.agentEnd({ messages: [{ role: 'user', content: 'Open Novi in Cursor' }, { role: 'assistant', content: 'Opened.' }], success: true });
    const y = await run('conversation_history', { date: 'yesterday' });
    expect(y.exchanges).toEqual([{ at: expect.stringMatching(/^2026-10-06T/), user: "What's the weather in Pune?", novi: '23 degrees and clear.' }]);
    expect(y.sensitive).toBe(true);
    const search = await run('conversation_history', { query: 'cursor' });
    expect(search.exchanges.map((e) => e.user)).toEqual(['Open Novi in Cursor']);
  });

  it('accepts an exact date', async () => {
    const { host, run } = setup();
    clock = new Date('2026-10-01T12:00:00');
    await host.agentEnd({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], success: true });
    expect((await run('conversation_history', { date: '2026-10-01' })).exchanges).toHaveLength(1);
    expect((await run('conversation_history', { date: '2026-10-02' })).text).toMatch(/nothing/i);
  });
});
