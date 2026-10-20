import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { chatKind, messageKey, newSince, toMarkdown, crosscheckPrompt } from './chat.js';

// The user's planning chat (2026-10-20: "whenever I wish to change something I can just make a plan on
// ChatGPT and then you implement it"). Novi reads the real chat in the user's Chrome (Novi extension,
// background tab), keeps a private copy in chatgpt/ (gitignored), and cross-checks every new ChatGPT
// answer against CLAUDE.md with free Gemini → chatgpt/crosscheck.md + Novi Memory note "ChatGPT plan".
// Claude reads both files when the user says "implement the ChatGPT plan".
const MESSAGES = '[data-message-author-role]';
const ROLE = 'data-message-author-role';
const LOGIN = 'button[data-testid="login-button"], a[href*="auth/login"]';
const stamp = (d) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const obj = (properties, required = []) => ({ type: 'object', properties, required });

export function createSync({ dir, guideFile, runtime: rt, now = () => new Date(), log = () => {} }) {
  const stateFile = path.join(dir, 'chat.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const save = (s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };
  let tabId = null;
  let running = null;

  async function open(request, url) {
    const known = tabId && ((await request('tabs')).tabs || []).some((t) => t.id === tabId);
    const opened = await request('open', known ? { url, tabId, background: true } : { url, newTab: true, background: true });
    tabId = opened?.tabId ?? tabId;
    const loaded = async () => (await request('waitFor', { selector: MESSAGES, ms: 20_000, tabId }, { timeoutMs: 25_000 })).found;
    if (await loaded()) return null;
    if ((await request('has', { selector: LOGIN, tabId })).found) return 'Log in to ChatGPT in Chrome, then ask me to check the plan again.';
    await request('switch', { tabId }); // Chrome holds back background tabs
    return (await loaded()) ? null : "Your ChatGPT chat didn't load in Chrome.";
  }

  async function run() {
    const st = load();
    const url = st.url || st.share;
    if (!url) return { error: 'Tell me the address of your ChatGPT chat first (open it in ChatGPT and copy the link, chatgpt.com/c/…).' };
    if (!rt.browserRequest || !rt.browserStatus?.().connected) return { error: "Chrome isn't connected to Novi, so I can't read your ChatGPT chat. Open Chrome (and check the Novi icon)." };
    const request = rt.browserRequest;
    const problem = await open(request, url);
    if (problem) return { error: problem };
    const got = await request('textsOf', { selector: MESSAGES, attr: ROLE, tabId });
    if (!got?.items) return { error: 'Reload the Novi extension in chrome://extensions (it needs version 1.5.0), then ask again.' };
    const messages = got.items.filter((m) => m.text).map((m) => ({ role: m.attr === 'user' ? 'you' : 'chatgpt', text: m.text }));
    const when = stamp(now());
    const title = st.title || 'NOVI';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${title}.md`), toMarkdown({ title, source: url, syncedAt: when, messages }));
    const fresh = newSince(st.seen, messages);
    save({ ...st, seen: messages.map(messageKey), lastSync: when, count: messages.length });
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
  const sync = () => (running ||= run().finally(() => { running = null; }));
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
        description: 'Read the user\'s ChatGPT planning chat now, save it and cross-check new plans against what Novi already has ("check my ChatGPT plan", "sync ChatGPT", "what did ChatGPT plan"). Answers at once, then says the result.',
        parameters: obj({}),
        async execute() {
          sync().then((out) => rt.say?.(out.error || out.note, { kind: null })).catch((err) => rt.say?.(`I couldn't read your ChatGPT chat: ${err.message}`, { kind: null }));
          return reply({ note: 'Checking your ChatGPT chat…' });
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
