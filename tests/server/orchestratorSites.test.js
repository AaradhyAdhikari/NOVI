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
    expect(calls.find(([c]) => c === 'open')[1]).toEqual({ url: SITES.chatgpt.url, slot: 'orchestrator-chatgpt', newTab: true, background: true });
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
    // One tab per site, kept by the extension (so a Novi restart doesn't open another one).
    expect(calls.filter(([c]) => c === 'open').map(([, a]) => a)).toEqual([
      { url: SITES.chatgpt.url, slot: 'orchestrator-chatgpt', newTab: true, background: true },
      { url: SITES.chatgpt.url, slot: 'orchestrator-chatgpt', newTab: true, background: true },
    ]);
    const opens = calls.filter(([c]) => c === 'open').length;
    await d.followUp('chatgpt', 'make it blue');
    expect(calls.filter(([c]) => c === 'open').length).toBe(opens);
  });

  it('logged out → says so; a page that never loads → says so', async () => {
    expect(await createSiteDriver({ request: fakeSite({ site: SITES.gemini, loads: false, login: true }).request, ...fast }).ask('gemini', 'x')).toEqual({ error: 'Gemini needs you to log in. Log in to Gemini in Chrome, then ask for the brief again.', login: true });
    expect(await createSiteDriver({ request: fakeSite({ loads: false }).request, ...fast }).ask('chatgpt', 'x')).toEqual({ error: "ChatGPT didn't load in Chrome." });
  });

  // 2026-10-22, user: "it should do all this work in background and not by using my screen". Novi never
  // brings a tab forward any more; a site that won't work hidden ends in words (the backup AI takes over).
  it('never brings a tab forward: nothing starts → waits, then says so; typing that did not land → tried once more, then says so', async () => {
    const slow = fakeSite({ startsAfterForward: true });
    expect(await createSiteDriver({ request: slow.request, ...fast, maxMs: 20_000 }).ask('chatgpt', 'x')).toEqual({ error: "ChatGPT didn't answer in time." });
    expect(slow.calls.some(([c]) => c === 'switch')).toBe(false);
    const stuck = fakeSite({ typing: false });
    expect(await createSiteDriver({ request: stuck.request, ...fast }).ask('chatgpt', 'Plan it')).toEqual({ error: "ChatGPT didn't take the message in the background." });
    expect(stuck.calls.filter(([c]) => c === 'typeSel')).toHaveLength(2);
    expect(stuck.calls.some(([c]) => c === 'switch')).toBe(false);
  });

  it('never finishes → what came so far (marked partial), or an error if nothing came', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `part ${i}`);
    expect(await createSiteDriver({ request: fakeSite({ answer: long }).request, ...fast, maxMs: 10_000 }).ask('chatgpt', 'x')).toMatchObject({ partial: true });
    const silent = fakeSite({ startsAfterForward: true });
    expect(await createSiteDriver({ request: silent.request, ...fast, maxMs: 20_000 }).ask('chatgpt', 'x')).toEqual({ error: "ChatGPT didn't answer in time." });
  });

  // First live run (2026-10-20): Gemini ended with a bare "timeout" (a Chrome step over 15 s) and the
  // brief said "timeout.". Now a slow load counts as "not loaded yet", and a slow step is named.
  it('a load wait that runs out is waited once more (in the background) instead of failing', async () => {
    const site = fakeSite({ site: SITES.gemini });
    let waits = 0;
    const req = async (cmd, a, o) => { if (cmd === 'waitFor' && (waits += 1) === 1) throw new Error('timeout'); return site.request(cmd, a, o); };
    expect(await createSiteDriver({ request: req, ...fast }).ask('gemini', 'x')).toMatchObject({ text: 'Goal\n1. Build\n2. Test' });
    expect(site.calls.some(([c]) => c === 'switch')).toBe(false);
  });

  it('a Chrome step that times out says which site, in words; slow steps get more time', async () => {
    const logs = [];
    const site = fakeSite({ site: SITES.gemini });
    const req = async (cmd, a, o) => { if (cmd === 'typeSel') throw new Error('timeout'); return site.request(cmd, a, o); };
    expect(await createSiteDriver({ request: req, ...fast, log: (m) => logs.push(m) }).ask('gemini', 'x')).toEqual({ error: "Gemini didn't answer in time (Chrome was slow while typing)." });
    expect(logs.join('\n')).toMatch(/Gemini: typeSel timed out/);
    const calls = fakeSite();
    await createSiteDriver({ request: calls.request, ...fast }).ask('chatgpt', 'x');
    expect(calls.calls.find(([c]) => c === 'open')[2]).toEqual({ timeoutMs: 40_000 });
  });

  // Second live run: ChatGPT was writing, but one "is it still writing?" check took over 15 s and the
  // whole answer was lost. A slow check while waiting is just skipped.
  it('a slow check while the answer is coming does not end it', async () => {
    const site = fakeSite();
    let slow = 0;
    const req = async (cmd, a, o) => { if (cmd === 'has' && a.selector === SITES.chatgpt.busy && (slow += 1) <= 2) throw new Error('timeout'); return site.request(cmd, a, o); };
    expect(await createSiteDriver({ request: req, ...fast }).ask('chatgpt', 'x')).toMatchObject({ text: 'Goal\n1. Build\n2. Test' });
  });

  // Fourth live run: Gemini's answer was read as just "Examples" — its stop button never matched, so a
  // short pause after the first heading looked like the end. Without a stop button seen, wait longer.
  it('no stop button ever seen: a pause in the answer is not the end', async () => {
    const answer = ['Examples', 'Examples', 'Examples', 'Examples\n- Calculator.net', 'Examples\n- Calculator.net\n## Security rules\n1. Validate'];
    const site = fakeSite({ site: SITES.gemini, answer });
    const req = async (cmd, a, o) => (cmd === 'has' && a.selector === SITES.gemini.busy ? { found: false } : site.request(cmd, a, o));
    expect(await createSiteDriver({ request: req, ...fast }).ask('gemini', 'x')).toEqual({ text: answer[4] });
  });

  // Seventh live run: Gemini's text was still "Gemini said / Examples" when it looked finished (its stop
  // button never matched). An answer is done only once every heading Novi asked for is in it.
  it('waits until every heading asked for is in the answer', async () => {
    const answer = [...Array(8).fill('Gemini said\nExamples'), 'Gemini said\nExamples\nCalculator.net\nSecurity rules\nValidate input'];
    const site = fakeSite({ site: SITES.gemini, answer });
    const req = async (cmd, a, o) => (cmd === 'has' && a.selector === SITES.gemini.busy ? { found: false } : site.request(cmd, a, o));
    expect(await createSiteDriver({ request: req, ...fast }).ask('gemini', 'x', { want: ['Examples', 'Security rules'] })).toEqual({ text: answer[8] });
  });

  // Eighth live run: Gemini's text stayed "Gemini said" for 2 minutes — Chrome doesn't draw a hidden
  // tab's answer. Stuck short of the headings asked for → the tab comes forward once, then it fills in.
  it('an answer stuck without the asked-for headings: waited out in the background, what came is kept (partial)', async () => {
    const site = fakeSite({ site: SITES.gemini, answer: ['Gemini said'] });
    const req = async (cmd, a, o) => (cmd === 'has' && a.selector === SITES.gemini.busy ? { found: false } : site.request(cmd, a, o));
    expect(await createSiteDriver({ request: req, ...fast, maxMs: 20_000 }).ask('gemini', 'x', { want: ['Examples', 'Security rules'] })).toEqual({ text: 'Gemini said', partial: true });
    expect(site.calls.some(([c]) => c === 'switch')).toBe(false);
  });

  // Ninth live run: Gemini's "busy" marker seems to match all the time, so neither rule fired.
  it('a busy marker that never goes away: complete and still → done', async () => {
    const full = 'Gemini said\nExamples\nCalculator.net\nSecurity rules\nValidate input';
    const site = fakeSite({ site: SITES.gemini, answer: ['Gemini said', full] });
    const req = async (cmd, a, o) => (cmd === 'has' && a.selector === SITES.gemini.busy ? { found: true } : site.request(cmd, a, o));
    expect(await createSiteDriver({ request: req, ...fast }).ask('gemini', 'x', { want: ['Examples', 'Security rules'] })).toEqual({ text: full });
  });

  it('Chrome errors come back as words, never thrown', async () => {
    const d = createSiteDriver({ request: async () => { throw new Error("The Novi extension isn't connected."); }, ...fast });
    expect(await d.ask('chatgpt', 'x')).toEqual({ error: "The Novi extension isn't connected." });
  });
});
