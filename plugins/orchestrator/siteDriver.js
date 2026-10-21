import fs from 'node:fs';

// AI websites driven through the Novi Chrome extension, in background tabs (user's choice,
// 2026-10-18: ChatGPT for the plan, Gemini for examples + security). Where things are on each page
// lives in sites.json — when a site changes its page, that one file is fixed.
export const SITES = JSON.parse(fs.readFileSync(new URL('./sites.json', import.meta.url), 'utf8'));

// request = runtime.browserRequest(cmd, args, opts). Every answer is { text } (partial: true when the
// site never finished), or { error } (login: true when it wants a login). Nothing is thrown.
// What Chrome was doing when it was too slow (first live run 2026-10-20: Gemini ended as a bare "timeout").
const STEP = { open: 'opening the page', waitFor: 'loading the page', typeSel: 'while typing', clickSel: 'pressing send', textOf: 'reading the answer', query: 'reading the page', has: 'reading the page', tabs: 'listing tabs', switch: 'bringing the tab forward' };
// A heading line, however the site drew it ("## Security Rules:", "**Examples**", "2. Security rules").
const squash = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, ''); // "Look & feel" = "Look and feel"
export const hasHeading = (text, heading) => String(text).split('\n').some((l) => l.trim().length < 60 && squash(l).startsWith(squash(heading)));
// Slow steps get more time than the bridge's 15 s.
const SLOW = { open: 40_000, typeSel: 30_000, textOf: 30_000 };

export function createSiteDriver({ request: raw, sites = SITES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pollMs = 1500, startMs = 15_000, maxMs = 120_000, log = () => {} } = {}) {
  const tabs = {}; // site → the tab Novi opened for it
  const request = (cmd, args, opts) => raw(cmd, args, opts ?? (SLOW[cmd] ? { timeoutMs: SLOW[cmd] } : undefined))
    .catch((err) => { err.step ??= cmd; throw err; });

  async function openFresh(key) {
    const site = sites[key];
    const known = tabs[key] && ((await request('tabs')).tabs || []).some((t) => t.id === tabs[key]);
    const opened = await request('open', known ? { url: site.url, tabId: tabs[key], background: true } : { url: site.url, newTab: true, background: true });
    tabs[key] = opened?.tabId ?? tabs[key];
  }

  // The message box shows up, or why not (login / not loaded). The page wait is shorter than the
  // wait for Chrome's answer (a slow page must not end as a bare "timeout"); one that still runs
  // out counts as "not loaded yet" (a background tab Chrome held back).
  async function ready(key) {
    const site = sites[key];
    const tabId = tabs[key];
    const loaded = async () => {
      try { return (await request('waitFor', { selector: site.input, ms: 20_000, tabId }, { timeoutMs: 25_000 })).found; } catch (err) {
        if (/timeout/i.test(err.message)) { log(`[orchestrator] ${site.name}: the page didn't answer the load wait`); return false; }
        throw err;
      }
    };
    if (await loaded()) return null;
    if (site.login && (await request('has', { selector: site.login, tabId })).found) {
      return { error: `${site.name} needs you to log in. Log in to ${site.name} in Chrome, then ask for the brief again.`, login: true };
    }
    log(`[orchestrator] ${site.name}: not loaded in the background, bringing the tab forward`);
    await request('switch', { tabId });
    return (await loaded()) ? null : { error: `${site.name} didn't load in Chrome.` };
  }

  async function send(key, text, want = []) {
    const site = sites[key];
    const tabId = tabs[key];
    const before = (await request('textOf', { selector: site.answer, tabId })).count || 0;
    let forwarded = false;
    const type = async () => {
      await request('typeSel', { selector: site.input, text, tabId });
      const shown = ((await request('query', { selector: site.input, tabId })).texts || [])[0] || '';
      return shown.includes(text.replace(/\s+/g, ' ').trim().slice(0, 20));
    };
    if (!(await type())) {
      log(`[orchestrator] ${site.name}: typing in the background did not land, bringing the tab forward`);
      forwarded = true;
      await request('switch', { tabId });
      await type();
    }
    try { await request('clickSel', { selector: site.send, tabId }); } catch { await request('key', { key: 'Enter', tabId }); }

    // Done = a new answer, the "stop" button gone, and the text the same on two polls in a row.
    const start = now();
    let last = '';
    let same = 0; // checks in a row with the same text
    let sawBusy = false; // the site's stop button showed at least once
    while (now() - start <= maxMs) {
      await sleep(pollMs);
      // A check Chrome is slow on (a busy page in a held-back tab) is skipped, not the end (live 2026-10-20).
      let busy;
      let count = 0;
      let answer = '';
      try {
        busy = (await request('has', { selector: site.busy, tabId })).found;
        ({ count = 0, text: answer = '' } = await request('textOf', { selector: site.answer, tabId }));
      } catch (err) {
        if (!/timeout/i.test(err.message)) throw err;
        log(`[orchestrator] ${site.name}: a check while waiting was slow (${err.step}), trying again`);
        continue;
      }
      if (busy) sawBusy = true;
      if (count > before && answer) {
        // Done = no stop button and the same text again. A site whose stop button Novi never saw (live
        // 2026-10-20: Gemini read as just "Examples") must stay the same for 3 more checks (~4.5 s).
        same = answer === last ? same + 1 : 0;
        const complete = want.every((h) => hasHeading(answer, h));
        // Unchanged for ~12 s with every heading in: done even if the busy marker never goes away
        // (live 2026-10-20: Gemini's seemed to match all the time).
        if (complete && ((!busy && same >= (sawBusy ? 1 : 3)) || same >= 8)) return { text: answer };
        // Stuck short of the headings asked for: Chrome doesn't draw a hidden tab's answer (live
        // 2026-10-20: Gemini stayed "Gemini said" for 2 minutes). Bring it forward once.
        if (!forwarded && same >= 4 && !complete) {
          log(`[orchestrator] ${site.name}: the answer stopped short of ${want.filter((h) => !hasHeading(answer, h)).join(' / ')}, bringing the tab forward`);
          forwarded = true;
          await request('switch', { tabId });
        }
        last = answer;
      } else if (!forwarded && now() - start > startMs) {
        // Chrome may hold back a page in the background: bring it forward once.
        log(`[orchestrator] ${site.name}: nothing started in the background, bringing the tab forward`);
        forwarded = true;
        await request('switch', { tabId });
      }
    }
    return last ? { text: last, partial: true } : { error: `${site.name} didn't answer in time.` };
  }

  const guard = (fn) => async (key, ...args) => {
    try { return await fn(key, ...args); } catch (err) {
      const name = sites[key]?.name || key;
      if (/timeout/i.test(String(err?.message))) {
        log(`[orchestrator] ${name}: ${err.step || 'a step'} timed out`);
        return { error: `${name} didn't answer in time (Chrome was slow ${STEP[err.step] || 'on a step'}).` };
      }
      return { error: String(err?.message || err) };
    }
  };
  return {
    // A fresh chat with the prompt.
    // want: the headings the answer must have before it counts as finished.
    ask: guard(async (key, prompt, { want } = {}) => {
      await openFresh(key);
      return (await ready(key)) || send(key, prompt, want);
    }),
    // More in the same chat ("change X").
    followUp: guard(async (key, text, { want } = {}) => {
      if (!tabs[key]) return { error: `There's no ${sites[key].name} chat to continue.` };
      return (await ready(key)) || send(key, text, want);
    }),
  };
}
