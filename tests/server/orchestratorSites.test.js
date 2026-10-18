import { describe, it, expect } from 'vitest';
import { createSiteDriver, SITES } from '../../plugins/orchestrator/siteDriver.js';

// A fake chat site behind the Novi extension: the answer streams in over a few polls, then the
// "stop" button goes away. No real site is ever touched in tests.
function fakeSite({ site = SITES.chatgpt, loads = true, login = false, answer = ['Goal', 'Goal\n1. Build', 'Goal\n1. Build\n2. Test'], startsAfterForward = false, typing = true, tabs = [] } = {}) {
  const calls = [];
  let sent = 0;
  let polls = 0;
  let forwarded = false;
  let typed = '';
  const old = 1; // one answer already on the page (an older chat)
  const request = async (cmd, args = {}, opts) => {
    calls.push([cmd, args, ...(opts ? [opts] : [])]);
    if (cmd === 'tabs') return { tabs };
    if (cmd === 'open') return { tabId: args.tabId ?? 5 };
    if (cmd === 'switch') { forwarded = true; return {}; }
    if (cmd === 'waitFor') return { found: loads };
    if (cmd === 'has' && args.selector === site.login) return { found: login };
    if (cmd === 'typeSel') { if (typing || forwarded) typed = args.text; return {}; }
    if (cmd === 'query' && args.selector === site.input) return { texts: [typed.replace(/\s+/g, ' ').slice(0, 80)] };
    if (cmd === 'clickSel') { sent += 1; return {}; }
    const going = sent > 0 && (!startsAfterForward || forwarded);
    if (cmd === 'has' && args.selector === site.busy) return { found: going && polls < answer.length };
    if (cmd === 'textOf') {
      if (!going) return { count: old, text: 'an old answer' };
      polls += 1;
      return { count: old + 1, text: answer[Math.min(polls - 1, answer.length - 1)] };
    }
    return {};
  };
  return { request, calls };
}
let t = 0;
const fast = { sleep: async () => { t += 1000; }, now: () => t };

describe('AI site driver (ChatGPT / Gemini through the Novi extension)', () => {
  it('fresh chat in a background tab, prompt typed and sent, the whole finished answer read back', async () => {
    const { request, calls } = fakeSite();
    const d = createSiteDriver({ request, ...fast });
    expect(await d.ask('chatgpt', 'Plan my portfolio')).toEqual({ text: 'Goal\n1. Build\n2. Test' });
    expect(calls.find(([c]) => c === 'open')[1]).toEqual({ url: SITES.chatgpt.url, newTab: true, background: true });
    const wait = calls.find(([c]) => c === 'waitFor');
    expect(wait[2].timeoutMs).toBeGreaterThan(wait[1].ms);
    expect(calls.find(([c]) => c === 'typeSel')[1]).toMatchObject({ selector: SITES.chatgpt.input, text: 'Plan my portfolio', tabId: 5 });
    expect(calls.some(([c]) => c === 'switch')).toBe(false);
  });

  it('the next ask reuses its own tab for a fresh chat; a follow-up stays in the same chat', async () => {
    const { request, calls } = fakeSite({ tabs: [{ id: 5, url: 'https://chatgpt.com/c/1' }] });
    const d = createSiteDriver({ request, ...fast });
    await d.ask('chatgpt', 'one');
    await d.ask('chatgpt', 'two');
    expect(calls.filter(([c]) => c === 'open').map(([, a]) => a)).toEqual([
      { url: SITES.chatgpt.url, newTab: true, background: true },
      { url: SITES.chatgpt.url, tabId: 5, background: true },
    ]);
    const opens = calls.filter(([c]) => c === 'open').length;
    await d.followUp('chatgpt', 'make it blue');
    expect(calls.filter(([c]) => c === 'open').length).toBe(opens);
  });

  it('logged out → says so; a page that never loads → says so', async () => {
    expect(await createSiteDriver({ request: fakeSite({ site: SITES.gemini, loads: false, login: true }).request, ...fast }).ask('gemini', 'x')).toEqual({ error: 'Gemini needs you to log in. Log in to Gemini in Chrome, then ask for the brief again.', login: true });
    expect(await createSiteDriver({ request: fakeSite({ loads: false }).request, ...fast }).ask('chatgpt', 'x')).toEqual({ error: "ChatGPT didn't load in Chrome." });
  });

  it('nothing starts in the background → the tab comes forward once; typing that did not land is retried in front', async () => {
    const slow = fakeSite({ startsAfterForward: true });
    expect(await createSiteDriver({ request: slow.request, ...fast }).ask('chatgpt', 'x')).toMatchObject({ text: 'Goal\n1. Build\n2. Test' });
    expect(slow.calls.filter(([c]) => c === 'switch')).toHaveLength(1);
    const stuck = fakeSite({ typing: false });
    await createSiteDriver({ request: stuck.request, ...fast }).ask('chatgpt', 'Plan it');
    expect(stuck.calls.filter(([c]) => c === 'typeSel')).toHaveLength(2);
  });

  it('never finishes → what came so far (marked partial), or an error if nothing came', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `part ${i}`);
    expect(await createSiteDriver({ request: fakeSite({ answer: long }).request, ...fast, maxMs: 10_000 }).ask('chatgpt', 'x')).toMatchObject({ partial: true });
    const silent = fakeSite({ startsAfterForward: true });
    const req = async (cmd, a, o) => (cmd === 'switch' ? {} : silent.request(cmd, a, o));
    expect(await createSiteDriver({ request: req, ...fast, maxMs: 20_000 }).ask('chatgpt', 'x')).toEqual({ error: "ChatGPT didn't answer in time." });
  });

  it('Chrome errors come back as words, never thrown', async () => {
    const d = createSiteDriver({ request: async () => { throw new Error("The Novi extension isn't connected."); }, ...fast });
    expect(await d.ask('chatgpt', 'x')).toEqual({ error: "The Novi extension isn't connected." });
  });
});
