import fs from 'node:fs';

// claude.ai Projects through the Novi Chrome extension, in a background tab (user, 2026-10-18: every
// project should also be a Claude project). Where things are on the page lives in claude.json — fix
// it there when claude.ai changes. Every answer is a plain object; nothing is thrown.
export const CLAUDE = JSON.parse(fs.readFileSync(new URL('./claude.json', import.meta.url), 'utf8'));

// Steps Chrome is slow with in a background tab get more time than the bridge's 15 s (live 2026-10-21:
// making Tip calculator failed with a bare "timeout").
const SLOW = { open: 40_000, typeSel: 30_000, clickSel: 30_000, query: 30_000 };

export function createClaudeWeb({ request, site = CLAUDE, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1000, maxMs = 20_000 } = {}) {
  let tabId = null;
  // One step, named when Chrome doesn't answer in time.
  const step = async (what, cmd, args) => {
    try { return await request(cmd, args, { timeoutMs: SLOW[cmd] }); } catch (err) {
      if (/timeout/i.test(err?.message)) throw new Error(`Chrome didn't answer in time while ${what} on claude.ai. Try again in a moment.`);
      throw err;
    }
  };

  // Its own tab in Novi's minimized Chrome window, kept by the extension ("slot": one tab, also after a
  // restart), never brought forward (user, 2026-10-22: "it opens too many tabs… not by using my screen").
  async function open(url) {
    const out = await step('opening the page', 'open', { url, slot: 'claude-link', newTab: true, background: true });
    tabId = out?.tabId ?? tabId;
  }
  // A wait Chrome doesn't answer in time (a hidden tab it holds back) counts as "not there yet".
  const waitFor = async (selector, ms = 15_000) => {
    try { return Boolean((await request('waitFor', { selector, ms, tabId }, { timeoutMs: ms + 5_000 }))?.found); } catch (err) {
      if (/timeout/i.test(err.message)) return false;
      throw err;
    }
  };
  const loginNeeded = async () => Boolean((await request('has', { selector: site.login, tabId }))?.found);
  // Live 2026-10-21: the new-project page never showed in a background tab ("claude.ai didn't load"),
  // so the Tip calculator never reached claude.ai. Not there yet → waited once more (in the background).
  async function ready(selector, ms) {
    if (await waitFor(selector, ms)) return true;
    if (await loginNeeded()) return 'login';
    return waitFor(selector, ms);
  }
  const whereIs = async () => {
    const url = ((await request('tabs')).tabs || []).find((t) => t.id === tabId)?.url || '';
    return url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/$/, '') || 'an empty page';
  };
  const notReady = async () => ((await loginNeeded())
    ? { error: 'Claude needs you to log in. Log in to Claude in Chrome (claude.ai), then ask again.', login: true }
    : { error: "claude.ai didn't load in Chrome." });
  // The first of several button texts that is on the page.
  async function clickText(selector, texts) {
    for (const text of texts) {
      try { const r = await request('clickSel', { selector, text, tabId }); if (!r?.error) return true; } catch { /* next text */ }
    }
    return false;
  }

  // Every project card, scrolling until no new one shows up (claude.ai loads more as you scroll).
  async function list() {
    await open(site.list);
    const shown = await ready(site.cards);
    if (shown !== true) {
      if (shown === 'login' || (await loginNeeded())) return notReady();
      return { error: "I couldn't read your projects on claude.ai (the page may have changed, or it didn't load). Open claude.ai/projects in Chrome and ask again." };
    }
    const projects = [];
    for (let round = 0, quiet = 0; round < 20 && quiet < 2; round++) {
      const out = (await request('query', { selector: site.cards, tabId, firstLine: true, attr: 'href', scrollLast: true })) || {};
      const { texts = [], values } = out;
      if (texts.length && !values) return { error: 'Reload the Novi extension in chrome://extensions (Novi needs its new version to read claude.ai), then ask again.' };
      let fresh = 0;
      // An icon on a card (an icon-font character, no letters) is not a name; one link = one project.
      texts.forEach((t, i) => {
        const name = String(t).split('\n')[0].trim();
        const url = values[i] ? new URL(values[i], 'https://claude.ai').href : null;
        if (!/[\p{L}\p{N}]/u.test(name) || projects.some((p) => p.name === name || (url && p.url === url))) return;
        projects.push({ name, url });
        fresh += 1;
      });
      quiet = fresh ? 0 : quiet + 1;
      if (quiet < 2) await sleep(pollMs);
    }
    if (!projects.length) return { error: "I couldn't read your projects on claude.ai (the page may have changed, or it didn't load). Open claude.ai/projects in Chrome and ask again." };
    return { names: projects.map((p) => p.name), projects };
  }

  // A project's page: the titles of its chats, newest first as claude.ai lists them (≤ 10).
  async function info(url) {
    await open(url);
    if (!(await waitFor(site.chats, 12_000))) return (await loginNeeded()) ? notReady() : { chats: [] };
    const { texts = [] } = (await request('query', { selector: site.chats, tabId, firstLine: true })) || {};
    return { chats: [...new Set(texts.map((t) => String(t).split('\n')[0].trim()).filter(Boolean))].slice(0, 10) };
  }

  async function make({ name, description = '', instructions = '' }) {
    await open(site.create);
    const shown = await ready(site.nameInput);
    if (shown === 'login') return notReady();
    if (!shown) return { error: `claude.ai didn't show the new-project page (the tab is on ${await whereIs()}).` };
    await step('typing the project name', 'typeSel', { selector: site.nameInput, text: name, tabId });
    if (description) await step('typing the description', 'typeSel', { selector: site.descriptionInput, text: description, tabId });
    await step('pressing Create project', 'clickSel', { selector: site.submit, tabId });
    // The new project's own page: claude.ai/project/<id>.
    let url = null;
    for (let waited = 0; waited <= maxMs && !url; waited += pollMs) {
      await sleep(pollMs);
      const tab = ((await request('tabs')).tabs || []).find((t) => t.id === tabId);
      if (/claude\.ai\/project\/[\w-]+/.test(tab?.url || '')) url = tab.url;
    }
    if (!url) return { error: `The new project page didn't open on claude.ai, so I'm not sure ${name} was made. Check claude.ai/projects in Chrome.` };
    if (!instructions) return { url };
    const out = await fill(instructions);
    return out.done ? { url } : { url, instructionsMissed: true };
  }

  // The project page's Instructions: a button labelled "Edit instructions" with no text of its own (live
  // 2026-10-28; the plain "Add" next to it is Context's file uploader, so it is never clicked by text). It
  // opens "Set project instructions". Only an empty box is filled: the user's own instructions stay.
  async function fill(instructions) {
    if (!(await waitFor(site.instructionsButton, 15_000))) return { instructionsMissed: true };
    let opened = false;
    try { opened = !(await request('clickSel', { selector: site.instructionsButton, tabId }))?.error; } catch { /* by its text */ }
    if (!opened) opened = await clickText(site.instructionsTextButton, site.instructionsTexts);
    if (!opened || !(await waitFor(site.instructionsBox, 8_000))) return { instructionsMissed: true };
    if (!(await request('has', { selector: site.emptyInstructionsBox, tabId }))?.found) {
      await clickText(site.saveButton, site.cancelTexts);
      return { already: true };
    }
    await step('typing the instructions', 'typeSel', { selector: site.instructionsBox, text: instructions, tabId });
    return (await clickText(site.saveButton, site.saveTexts)) ? { done: true } : { instructionsMissed: true };
  }

  // An existing project whose instructions were never added (Portfolio, Tip calculator, NOVI: the click
  // never happened before 2026-10-28) gets them now.
  async function instruct({ url, instructions }) {
    await open(url);
    const shown = await ready(site.page);
    if (shown === 'login') return notReady();
    if (!shown) return { error: `claude.ai didn't show the project page (the tab is on ${await whereIs()}).` };
    return fill(instructions);
  }

  // claude.ai/settings/usage: on desktop a Settings pop-up over a new chat (live 2026-10-29) — its text,
  // once the numbers show (usage.js reads them).
  async function usage() {
    await open('https://claude.ai/settings/usage');
    if (!(await waitFor('[role="dialog"]', 15_000))) return (await loginNeeded()) ? notReady() : { error: "claude.ai's Usage page didn't load in Chrome. Try again in a moment." };
    let text = '';
    for (let i = 0; i < 8; i += 1) {
      ({ text = '' } = (await request('textOf', { selector: '[role="dialog"]', tabId })) || {});
      if (text.includes('% used')) break;
      await sleep(pollMs);
    }
    return text.includes('% used') ? { text } : { error: "I opened claude.ai's Usage page but couldn't find the numbers." };
  }

  const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { return { error: String(err?.message || err) }; } };
  return { list: guard(list), make: guard(make), info: guard(info), usage: guard(usage), instruct: guard(instruct) };
}
