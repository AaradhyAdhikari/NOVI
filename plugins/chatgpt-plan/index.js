import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { chatKind, messageKey, newSince, toMarkdown, crosscheckPrompt } from './chat.js';

// The user's planning chat (2026-10-20: "whenever I wish to change something I can just make a plan on
// ChatGPT and then you implement it"). Novi reads the real chat in the user's Chrome (Novi extension,
// background tab), keeps a private copy in chatgpt/ (gitignored), and cross-checks every new ChatGPT
// answer against CLAUDE.md with free Gemini → chatgpt/crosscheck.md + Novi Memory note "ChatGPT plan".
// Claude reads both files when the user says "implement the ChatGPT plan".
// Your messages and ChatGPT's. Live 2026-10-20 ChatGPT dropped data-message-author-role (the sync waited
// for it and timed out); its pages now mark your bubble and its answer with different attributes. Both kept.
const MESSAGES = '[data-message-author-role], [data-user-message-bubble="true"], [data-markdown-text-style="assistant-message"]';
const ATTRS = ['data-message-author-role', 'data-user-message-bubble'];
const OPEN_SIDEBAR = 'button[aria-label="Open sidebar"], button[data-testid="open-sidebar-button"]';
const CLOSE_SIDEBAR = 'button[aria-label="Close sidebar"], button[data-testid="close-sidebar-button"]';
const SIDEBAR_HEADINGS = ['^projects$', '^pinned', '^(recents|chats|today|yesterday)$'];
const roleOf = (m) => (m.attrs['data-message-author-role'] === 'user' || m.attrs['data-user-message-bubble'] === 'true' ? 'you' : 'chatgpt');
const LOGIN = 'button[data-testid="login-button"], a[href*="auth/login"]';
const stamp = (d) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const obj = (properties, required = []) => ({ type: 'object', properties, required });

export function createSync({ dir, guideFile, runtime: rt, now = () => new Date(), log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const stateFile = path.join(dir, 'chat.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const save = (s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };
  let tabId = null;
  let running = null;

  // Its own tab in Novi's minimized Chrome window, kept by the extension ("slot": one tab, also after a
  // restart), never brought forward (user, 2026-10-22: "it opens too many tabs… not by using my screen").
  async function open(request, url, selector) {
    const opened = await request('open', { url, slot: 'chatgpt-plan', newTab: true, background: true }, { timeoutMs: 40_000 });
    tabId = opened?.tabId ?? tabId;
    // A hidden tab Chrome holds back can run past the wait (live 2026-10-20: "timeout") — count that as not loaded yet.
    const loaded = async () => {
      try { return (await request('waitFor', { selector, ms: 20_000, tabId }, { timeoutMs: 25_000 })).found; } catch (err) {
        if (/timeout/i.test(err.message)) { log(`[chatgpt-plan] ${url}: Chrome didn't answer the wait (tab held back?)`); return false; }
        throw err;
      }
    };
    if (await loaded()) return null;
    if ((await request('has', { selector: LOGIN, tabId })).found) return 'Log in to ChatGPT in Chrome, then ask me to check the plan again.';
    if (await loaded()) return null; // waited once more, in the background
    log(`[chatgpt-plan] ${url}: "${selector}" never showed in the background`);
    return "ChatGPT didn't load in Chrome. Check chatgpt.com opens in Chrome, then ask again.";
  }

  // The sidebar's projects and pinned chats → Novi Memory notes, which hang off the ChatGPT dot (user,
  // 2026-10-20: "if I add any pinned chat it gets updated, same for the project"). A project is noted once
  // (the list can hide some behind "See more", so a missing one is never called removed); a pin or an
  // unpin is noted when it happens. Nothing changes when the sidebar didn't show.
  async function readSidebar(request) {
    // The chat list isn't inside <nav> (live 2026-10-20); the first heading of each name wins.
    const read = () => request('groups', { root: 'body', headings: SIDEBAR_HEADINGS, tabId }, { timeoutMs: 30_000 }).catch(() => null);
    let got = await read();
    if (!got?.groups?.length) {
      // A closed sidebar draws no list (live: 0 chat links): open it, read, and close it again as it was.
      const opened = await request('clickSel', { selector: OPEN_SIDEBAR, tabId }).catch(() => null);
      if (opened && !opened.error) {
        await sleep(1500);
        got = await read();
        await request('clickSel', { selector: CLOSE_SIDEBAR, tabId }).catch(() => null);
      }
    }
    if (!got?.groups?.length) {
      // What the page has instead (headings and a link count only — never chat titles), to fix the reading.
      const links = await request('query', { selector: 'a[href*="/c/"], a[href$="/project"]', tabId }).catch(() => null);
      const heads = await request('query', { selector: 'h1, h2, h3, h4, [role="heading"]', tabId }).catch(() => null);
      log(`[chatgpt-plan] sidebar not found: ${links?.texts?.length ?? '?'} chat/project links; headings: ${(heads?.texts || []).slice(0, 8).join(' | ') || 'none'}`);
      return null;
    }
    const st = load();
    const section = (re) => got.groups.find((g) => re.test(g.heading));
    const abs = (href) => new URL(href, 'https://chatgpt.com').href;
    const projects = { ...(st.projects || {}) };
    for (const i of section(/^projects$/i)?.items || []) {
      if (!/\/project$/.test(i.href || '') || projects[abs(i.href)]) continue;
      projects[abs(i.href)] = i.text;
      rt.wikiWrite?.({ title: `${i.text} project`, text: `On ChatGPT: ${abs(i.href)}` });
    }
    const pinnedNow = (section(/^pinned/i)?.items || []).filter((i) => /\/c\/[\w-]+$/.test(i.href || ''));
    const pinned = {};
    for (const i of pinnedNow) {
      pinned[abs(i.href)] = i.text;
      if (!st.pinned?.[abs(i.href)]) rt.wikiWrite?.({ title: `${i.text} (pinned chat)`, text: `Pinned on ChatGPT: ${abs(i.href)}` });
    }
    for (const [url, name] of Object.entries(st.pinned || {})) {
      if (!pinned[url]) rt.wikiWrite?.({ title: `${name} (pinned chat)`, text: `Unpinned on ChatGPT: ${now().toISOString().slice(0, 10)}` });
    }
    save({ ...st, projects, pinned });
    const list = (o, one, many) => { const names = Object.values(o); return names.length ? `${names.length} ${names.length === 1 ? one : many} (${names.join(', ')})` : null; };
    const parts = [list(projects, 'project', 'projects'), list(pinned, 'pinned chat', 'pinned chats')].filter(Boolean);
    return parts.length ? `On ChatGPT: ${parts.join(' and ')}.` : 'No ChatGPT projects or pinned chats yet.';
  }

  async function run() {
    const st = load();
    if (!rt.browserRequest || !rt.browserStatus?.().connected) return { error: "Chrome isn't connected to Novi, so I can't read ChatGPT. Open Chrome (and check the Novi icon)." };
    // Which step Chrome was slow on goes to the log (live 2026-10-20: a bare "timeout").
    const request = (cmd, args, opts) => rt.browserRequest(cmd, args, opts).catch((err) => { log(`[chatgpt-plan] ${cmd}: ${err.message}`); throw err; });
    // A real chat page has the sidebar too; otherwise chatgpt.com first (a share page has no sidebar).
    let problem = await open(request, st.url || 'https://chatgpt.com/', st.url ? MESSAGES : 'nav');
    if (problem) return { error: problem };
    const side = await readSidebar(request);
    let chat = st.url;
    if (!chat) {
      // The pinned chat named like the planning chat ("NOVI") is the planning chat (user, 2026-10-20).
      const now2 = load();
      const pinnedUrl = Object.entries(now2.pinned || {}).find(([, name]) => name.toLowerCase() === (st.title || 'NOVI').toLowerCase())?.[0];
      if (pinnedUrl) { save({ ...now2, url: pinnedUrl }); chat = pinnedUrl; } else chat = st.share;
      if (!chat) return side ? { note: side } : { error: 'Tell me the address of your ChatGPT chat first (open it in ChatGPT and copy the link, chatgpt.com/c/…).' };
      problem = await open(request, chat, MESSAGES);
      if (problem) return { error: problem };
    }
    const withSide = (out) => (side && out.note ? { ...out, note: `${out.note} ${side}` } : out);
    return withSide(await readChat(request, load(), chat));
  }

  async function readChat(request, st, url) {
    const got = await request('textsOf', { selector: MESSAGES, attrs: ATTRS, tabId }, { timeoutMs: 40_000 });
    if (!got?.items || got.items.some((m) => !m.attrs)) return { error: 'Reload the Novi extension in chrome://extensions (it needs version 1.7.0), then ask again.' };
    const messages = got.items.filter((m) => m.text).map((m) => ({ role: roleOf(m), text: m.text }));
    const when = stamp(now());
    const title = st.title || 'NOVI';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${title}.md`), toMarkdown({ title, source: url, syncedAt: when, messages }));
    const fresh = newSince(st.seen, messages);
    save({ ...load(), seen: messages.map(messageKey), lastSync: when, count: messages.length }); // load(): keep what readSidebar just saved
    const answers = fresh.filter((m) => m.role === 'chatgpt');
    const saved = `Saved ${messages.length} messages from your ChatGPT chat`;
    if (!fresh.length) return { note: `${saved}; nothing new since the last check.` };
    if (!answers.length) return { note: `${saved} (${fresh.length} new from you, no new answer from ChatGPT yet).` };

    let guide = '';
    try { guide = fs.readFileSync(guideFile, 'utf8'); } catch { /* cross-check without it */ }
    let check;
    try { check = await rt.complete(crosscheckPrompt({ fresh, guide }), { prefer: 'gemini' }); } catch (err) {
      log(`[chatgpt-plan] cross-check failed: ${err.message}`);
      const unchecked = new Set(answers.map(messageKey)); // stay "new", so the next check cross-checks them
      save({ ...load(), seen: messages.map(messageKey).filter((k) => !unchecked.has(k)) });
      return { note: `${saved} (${answers.length} new from ChatGPT), but I couldn't cross-check it: the free AI was busy. I'll try at the next check.`, retry: true };
    }
    fs.appendFileSync(path.join(dir, 'crosscheck.md'), `## ${when} — ${answers.length} new ChatGPT message${answers.length === 1 ? '' : 's'}\n\n${check}\n\n`);
    rt.wikiWrite?.({ title: 'ChatGPT plan', text: `## ${when}\nNew from ChatGPT: ${answers.map((m) => m.text.split('\n')[0].slice(0, 120)).join(' · ')}\n\n${check}`.slice(0, 8000) });
    const next = /Next for Claude:\s*([\s\S]*)/i.exec(check)?.[1]?.trim().split('\n')[0];
    return { note: `${saved} (${answers.length} new from ChatGPT) and cross-checked it with what Novi has.${next ? ` Next for Claude: ${next.replace(/^[-*\d.\s]+/, '').slice(0, 160)}` : ''} It's in chatgpt/crosscheck.md.`, fresh: answers.length };
  }

  // One check at a time (the 30-minute timer and a voice request can meet).
  // Chrome's bare "timeout" said plainly (a slow or still-loading page).
  const safeRun = () => run().catch((err) => {
    if (/timeout/i.test(err.message)) return { error: "Chrome didn't answer in time (the ChatGPT page may still be loading). Try again in a moment." };
    // Live 2026-10-20: Chrome still ran extension 1.4.0 ("unknown command textsOf").
    if (/unknown command/i.test(err.message)) return { error: 'Reload the Novi extension in chrome://extensions (it needs version 1.7.0), then ask again.' };
    throw err;
  });
  const sync = () => (running ||= safeRun().finally(() => { running = null; }));
  sync.link = (url, title) => {
    const kind = chatKind(url);
    if (!kind) return { error: 'That is not a ChatGPT chat link. Open the chat in ChatGPT and copy its address (chatgpt.com/c/…).' };
    const st = load();
    save(kind === 'chat' ? { ...st, url, ...(title ? { title } : {}) } : { ...st, share: url, ...(title ? { title } : {}) });
    return { note: kind === 'chat' ? 'Linked your ChatGPT chat. I\'ll check it every 30 minutes while Chrome is open.' : 'Saved the share link. A share link only shows new messages after you press Share → Update link in ChatGPT, so the chat\'s own address (chatgpt.com/c/…) is better.' };
  };
  return sync;
}

export function createChatgptPlanPlugin({ firstMs = 90_000, everyMs = 30 * 60_000 } = {}) {
  return definePluginEntry({
    id: 'chatgpt-plan',
    name: 'ChatGPT plan',
    description: "Keeps a private copy of the user's ChatGPT planning chat and cross-checks new plans against what Novi has.",
    register(api) {
      const rt = api.runtime || {};
      const dir = api.pluginConfig?.dir || path.resolve('chatgpt');
      const log = (m) => api.logger?.info?.(m);
      const sync = createSync({ dir, guideFile: path.resolve('CLAUDE.md'), runtime: rt, log });
      const reply = (details) => ({ content: [], details });

      api.registerTool({
        name: 'chatgpt_plan_sync',
        description: 'Read ChatGPT now: the user\'s planning chat (saved and cross-checked against what Novi already has) and their ChatGPT projects and pinned chats ("check my ChatGPT plan", "sync ChatGPT", "sync my pinned chats", "what did ChatGPT plan"). Answers at once, then says the result.',
        parameters: obj({}),
        async execute() {
          sync().then((out) => rt.say?.(out.error || out.note, { kind: null })).catch((err) => rt.say?.(`I couldn't read your ChatGPT chat: ${err.message}`, { kind: null }));
          // Live 2026-10-20 the AI turned "Checking…" into "Your pinned chats have been synced": say it's only started.
          return reply({ note: 'Checking your ChatGPT chat…', status: 'Started, NOT finished. Tell the user only "Checking your ChatGPT chat…" — the result is said by itself when it ends.' });
        },
      });
      api.registerTool({
        name: 'chatgpt_plan_link',
        description: "Remember which ChatGPT chat is the user's planning chat (its address, chatgpt.com/c/… or a share link).",
        parameters: obj({ url: { type: 'string', description: 'The chat address' }, title: { type: 'string', description: 'Its name (optional)' } }, ['url']),
        async execute(_id, { url, title } = {}) { return reply(sync.link(url, title)); },
      });
      let first = null;
      let timer = null;
      api.registerService({
        id: 'chatgpt-plan',
        start() {
          const tick = () => sync().then((out) => out.error || log(`[chatgpt-plan] ${out.note}`)).catch((err) => log(`[chatgpt-plan] ${err.message}`));
          first = setTimeout(tick, firstMs);
          first.unref?.();
          timer = setInterval(tick, everyMs);
          timer.unref?.();
        },
        stop() { clearTimeout(first); clearInterval(timer); },
      });
    },
  });
}

export default createChatgptPlanPlugin();
