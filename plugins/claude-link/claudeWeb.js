import fs from 'node:fs';

// claude.ai Projects through the Novi Chrome extension, in a background tab (user, 2026-10-18: every
// project should also be a Claude project). Where things are on the page lives in claude.json — fix
// it there when claude.ai changes. Every answer is a plain object; nothing is thrown.
export const CLAUDE = JSON.parse(fs.readFileSync(new URL('./claude.json', import.meta.url), 'utf8'));

export function createClaudeWeb({ request, site = CLAUDE, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1000, maxMs = 20_000 } = {}) {
  let tabId = null;

  async function open(url) {
    const known = tabId && ((await request('tabs')).tabs || []).some((t) => t.id === tabId);
    const out = await request('open', known ? { url, tabId, background: true } : { url, newTab: true, background: true });
    tabId = out?.tabId ?? tabId;
  }
  const waitFor = async (selector, ms = 15_000) => Boolean((await request('waitFor', { selector, ms, tabId }, { timeoutMs: ms + 5_000 }))?.found);
  const loginNeeded = async () => Boolean((await request('has', { selector: site.login, tabId }))?.found);
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
    if (!(await waitFor(site.cards))) {
      if (await loginNeeded()) return notReady();
      return { error: "I couldn't read your projects on claude.ai (the page may have changed, or it didn't load). Open claude.ai/projects in Chrome and ask again." };
    }
    const projects = [];
    for (let round = 0, quiet = 0; round < 20 && quiet < 2; round++) {
      const out = (await request('query', { selector: site.cards, tabId, firstLine: true, attr: 'href', scrollLast: true })) || {};
      const { texts = [], values } = out;
      if (texts.length && !values) return { error: 'Reload the Novi extension in chrome://extensions (Novi needs its new version to read claude.ai), then ask again.' };
      let fresh = 0;
      texts.forEach((t, i) => {
        const name = String(t).split('\n')[0].trim();
        if (name && !projects.some((p) => p.name === name)) { projects.push({ name, url: values[i] ? new URL(values[i], 'https://claude.ai').href : null }); fresh += 1; }
      });
      quiet = fresh ? 0 : quiet + 1;
      if (quiet < 2) await sleep(pollMs);
    }
    if (!projects.length) return { error: "I couldn't read your projects on claude.ai (the page may have changed, or it didn't load). Open claude.ai/projects in Chrome and ask again." };
    return { names: projects.map((p) => p.name), projects };
  }

  async function make({ name, description = '', instructions = '' }) {
    await open(site.create);
    if (!(await waitFor(site.nameInput))) return notReady();
    await request('typeSel', { selector: site.nameInput, text: name, tabId });
    if (description) await request('typeSel', { selector: site.descriptionInput, text: description, tabId });
    await request('clickSel', { selector: site.submit, tabId });
    // The new project's own page: claude.ai/project/<id>.
    let url = null;
    for (let waited = 0; waited <= maxMs && !url; waited += pollMs) {
      await sleep(pollMs);
      const tab = ((await request('tabs')).tabs || []).find((t) => t.id === tabId);
      if (/claude\.ai\/project\/[\w-]+/.test(tab?.url || '')) url = tab.url;
    }
    if (!url) return { error: `The new project page didn't open on claude.ai, so I'm not sure ${name} was made. Check claude.ai/projects in Chrome.` };
    if (!instructions) return { url };
    const box = (await clickText(site.instructionsButton, site.instructionsTexts)) && (await waitFor(site.instructionsBox, 8_000));
    if (!box) return { url, instructionsMissed: true };
    await request('typeSel', { selector: site.instructionsBox, text: instructions, tabId });
    return (await clickText(site.saveButton, site.saveTexts)) ? { url } : { url, instructionsMissed: true };
  }

  const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { return { error: String(err?.message || err) }; } };
  return { list: guard(list), make: guard(make) };
}
