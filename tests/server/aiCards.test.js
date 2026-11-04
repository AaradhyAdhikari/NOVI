import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { PluginHost } from '../../server/plugins/host.js';
import { createAiCardsPlugin } from '../../plugins/ai-cards/index.js';
import { createBridge } from '../../plugins/browser/bridge.js';
import '../../extension/aiwatch.js';

const ANSWER = 'Here is a plan for the login page. First add a form, then check the password on the server.';

function setup({ decision = { allow: true }, project = { name: 'Portfolio', path: 'C:/dev/Portfolio', working: false }, summary = 'a plan for the login page' } = {}) {
  const asked = [];
  const started = [];
  const told = [];
  const said = [];
  const runtime = {
    ask: async (card) => { asked.push(card); return decision; },
    privateComplete: async () => { if (summary instanceof Error) throw summary; return summary; },
    codingProject: () => project,
    startCoding: async (job) => { started.push(job); return {}; },
    tellCoder: async (text) => { told.push(text); return {}; },
    say: (text) => said.push(text),
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, info() {} } });
  expect(host.register(createAiCardsPlugin())).toBe(true);
  return { asked, started, told, said, send: (e) => host.runtime.aiAnswer({ site: 'ChatGPT', text: ANSWER, ...e }) };
}

describe('an AI finished', () => {
  it('a short card says who answered and the gist, with the whole answer behind it', async () => {
    const s = setup();
    await s.send();
    expect(s.asked[0].title).toBe('ChatGPT answered: “Here is a plan for the login page”');
    expect(s.asked[0].prompt).toBe('ChatGPT answered: Here is a plan for the login page. Send it to Claude in Portfolio?');
    expect(s.asked[0].detail).toBe(ANSWER);
  });

  it('yes starts Claude on the project in hand, the answer marked as coming from that AI', async () => {
    const s = setup();
    await s.send();
    expect(s.started[0].project).toBe('Portfolio');
    expect(s.started[0].planFirst).toBe(true); // Claude shows its plan before anything runs
    expect(s.started[0].instruction).toContain('from ChatGPT');
    expect(s.started[0].instruction).toContain(ANSWER);
  });

  it('Claude already working on it: the answer goes to that task', async () => {
    const s = setup({ project: { name: 'Portfolio', path: 'p', working: true } });
    await s.send();
    expect(s.started).toEqual([]);
    expect(s.told[0]).toContain(ANSWER);
  });

  it('"yes, also X" goes along', async () => {
    const s = setup({ decision: { allow: true, addition: 'use dark mode' } });
    await s.send();
    expect(s.started[0].instruction).toContain('Also: use dark mode');
  });

  it('no: nothing goes anywhere', async () => {
    const s = setup({ decision: { allow: false } });
    await s.send();
    expect(s.started).toEqual([]);
    expect(s.told).toEqual([]);
  });

  it('no project known: says so instead of guessing', async () => {
    const s = setup({ project: null });
    await s.send();
    expect(s.started).toEqual([]);
    expect(s.asked).toEqual([]);
    expect(s.said[0]).toMatch(/which project/i);
  });

  it('the same answer twice is one card; other sites and empty answers are none', async () => {
    const s = setup();
    await s.send();
    await s.send();
    await s.send({ site: 'Some Website' });
    await s.send({ text: '   ' });
    expect(s.asked.length).toBe(1);
  });
});

describe('watching an answer arrive', () => {
  const step = globalThis.noviWatchStep;
  const run = (samples) => {
    const state = {};
    return samples.map((s) => step(state, s)).filter(Boolean);
  };
  const t = (text, busy = false) => ({ text, busy });

  it('an answer that grows and then rests is reported once', () => {
    expect(run([t(''), t('He'), t('Hello'), t('Hello there'), t('Hello there'), t('Hello there'), t('Hello there'), t('Hello there')])).toEqual(['Hello there']);
  });
  it('not while the stop button is up', () => {
    expect(run([t('a'), t('a', true), t('a', true), t('a', true), t('a', true)])).toEqual([]);
  });
  it('a stop button that goes away counts even if the words came at once', () => {
    expect(run([t(''), t('', true), t('Done', true), t('Done'), t('Done'), t('Done'), t('Done')])).toEqual(['Done']);
  });
  it('opening an old chat is not an answer: the text appears in one jump', () => {
    expect(run([t(''), t('An old answer'), t('An old answer'), t('An old answer'), t('An old answer'), t('An old answer')])).toEqual([]);
  });
  it('the next answer is reported too', () => {
    expect(run([t(''), t('A'), t('AB'), t('AB'), t('AB'), t('AB'), t('X'), t('XY'), t('XY'), t('XY'), t('XY')])).toEqual(['AB', 'XY']);
  });
});

describe('two Chrome profiles at once', () => {
  const ORIGIN = 'chrome-extension://abcdefghijklmnop';
  let bridge;
  afterEach(() => bridge?.stop());
  const open = (port) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: ORIGIN } });
    const got = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', code: 'c', version: '9.9.9' })));
    ws.on('message', (m) => { const d = JSON.parse(m); got.push(d); if (d.type === 'welcome') resolve({ ws, got }); });
  });
  const wait = (ok) => new Promise((resolve) => { const t = setInterval(() => { if (ok()) { clearInterval(t); resolve(); } }, 10); });

  it('both connect; jobs go to the first; events come from either; the second takes over if the first goes', async () => {
    const events = [];
    bridge = createBridge({ port: 0, code: 'c', logger: { warn() {}, info() {} }, onEvent: (e) => { events.push(e); return { done: true }; } });
    await bridge.start();
    const a = await open(bridge.port());
    const b = await open(bridge.port());
    a.ws.on('message', (m) => { const d = JSON.parse(m); if (d.cmd) a.ws.send(JSON.stringify({ id: d.id, ok: true, by: 'a' })); });
    b.ws.on('message', (m) => { const d = JSON.parse(m); if (d.cmd) b.ws.send(JSON.stringify({ id: d.id, ok: true, by: 'b' })); });
    expect((await bridge.request('tabs')).by).toBe('a');
    b.ws.send(JSON.stringify({ type: 'event', ref: 1, event: 'ai_answer' }));
    await wait(() => events.length === 1);
    a.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await bridge.request('tabs')).by).toBe('b');
    b.ws.close();
  });
});
