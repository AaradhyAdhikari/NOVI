import fs from 'node:fs';

// AI websites driven through the Novi Chrome extension, in background tabs (user's choice,
// 2026-10-18: ChatGPT for the plan, Gemini for examples + security). Where things are on each page
// lives in sites.json — when a site changes its page, that one file is fixed.
export const SITES = JSON.parse(fs.readFileSync(new URL('./sites.json', import.meta.url), 'utf8'));

// request = runtime.browserRequest(cmd, args, opts). Every answer is { text } (partial: true when the
// site never finished), or { error } (login: true when it wants a login). Nothing is thrown.
export function createSiteDriver({ request, sites = SITES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pollMs = 1500, startMs = 15_000, maxMs = 120_000, log = () => {} } = {}) {
  const tabs = {}; // site → the tab Novi opened for it

  async function openFresh(key) {
    const site = sites[key];
    const known = tabs[key] && ((await request('tabs')).tabs || []).some((t) => t.id === tabs[key]);
    const opened = await request('open', known ? { url: site.url, tabId: tabs[key], background: true } : { url: site.url, newTab: true, background: true });
    tabs[key] = opened?.tabId ?? tabs[key];
  }

  // The message box shows up, or why not (login / not loaded). The page wait is shorter than the
  // wait for Chrome's answer (a slow page must not end as a bare "timeout").
  async function ready(key) {
    const site = sites[key];
    const tabId = tabs[key];
    const loaded = async () => (await request('waitFor', { selector: site.input, ms: 20_000, tabId }, { timeoutMs: 25_000 })).found;
    if (await loaded()) return null;
    if (site.login && (await request('has', { selector: site.login, tabId })).found) {
      return { error: `${site.name} needs you to log in. Log in to ${site.name} in Chrome, then ask for the brief again.`, login: true };
    }
    log(`[orchestrator] ${site.name}: not loaded in the background, bringing the tab forward`);
    await request('switch', { tabId });
    return (await loaded()) ? null : { error: `${site.name} didn't load in Chrome.` };
  }

  async function send(key, text) {
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
    while (now() - start <= maxMs) {
      await sleep(pollMs);
      const busy = (await request('has', { selector: site.busy, tabId })).found;
      const { count = 0, text: answer = '' } = await request('textOf', { selector: site.answer, tabId });
      if (count > before && answer) {
        if (!busy && answer === last) return { text: answer };
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

  const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { return { error: String(err?.message || err) }; } };
  return {
    // A fresh chat with the prompt.
    ask: guard(async (key, prompt) => {
      await openFresh(key);
      return (await ready(key)) || send(key, prompt);
    }),
    // More in the same chat ("change X").
    followUp: guard(async (key, text) => {
      if (!tabs[key]) return { error: `There's no ${sites[key].name} chat to continue.` };
      return (await ready(key)) || send(key, text);
    }),
  };
}
