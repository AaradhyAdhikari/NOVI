// New AIs join by themselves (2026-11-12, user: "what if I added Gemini it should automatically get added…
// don't make them rule based… it should be done for all"). No site list and no hand-written page parts: any
// chat-shaped page is driven in general terms by the extension (chatAsk: the biggest message box, typed, Enter
// or the button next to it; chatRead: the page text + whether a "stop" button shows), and the answer is the
// text that appeared under the message. A learned site is a team member like any other.

const lines = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// What the site answered: the lines after the last line that holds the start of the prompt, minus lines
// that were on the page before (menus, "Regenerate", the box's placeholder). No prompt on the page (sites
// cut long ones): the lines that are new.
export function answerAfter(before, after, prompt) {
  const old = new Set(lines(before));
  const all = lines(after);
  const head = lines(prompt)[0]?.slice(0, 40).toLowerCase() || '';
  let at = -1;
  if (head) for (let i = all.length - 1; i >= 0; i--) if (all[i].toLowerCase().includes(head)) { at = i; break; }
  const tail = at >= 0 ? all.slice(at + 1) : all;
  const fresh = tail.filter((l) => !old.has(l));
  return fresh.join('\n').trim();
}

const SITE_ROLES = ['research', 'plan', 'review'];
// spec: { host, url, name }. rt: browserRequest + browserStatus. Runs in Novi's own hidden work window.
export function siteAdapter(spec, { rt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxMs = 150_000 } = {}) {
  const slot = `team-${spec.host}`;
  return {
    id: String(spec.host).replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    name: spec.name || spec.host,
    aliases: [spec.host, String(spec.host).replace(/^www\./, '').split('.')[0]],
    roles: SITE_ROLES,
    order: 60, // learned members start after the known ones; the track record moves them
    learned: true,
    available: async () => (rt.browserStatus?.().connected ? { ok: true } : { ok: false, why: `${spec.name || spec.host} needs Chrome connected with the Novi extension` }),
    async run(pkg) {
      const { tabId } = await rt.browserRequest('open', { url: spec.url, slot, newTab: true, background: true }, { timeoutMs: 40_000 });
      await sleep(2500);
      const before = (await rt.browserRequest('chatRead', { tabId }).catch(() => ({ text: '' }))).text || '';
      const sent = await rt.browserRequest('chatAsk', { tabId, text: pkg }, { timeoutMs: 30_000 });
      if (!sent?.sent) return { ok: false, error: `${spec.name || spec.host} didn't take the message (${sent?.why || 'no message box'})` };
      const start = Date.now();
      let last = '';
      let same = 0;
      while (Date.now() - start < maxMs) {
        await sleep(1500);
        const r = await rt.browserRequest('chatRead', { tabId }).catch(() => null);
        if (!r) continue;
        const answer = answerAfter(before, r.text, pkg);
        if (answer && answer === last && !r.busy) { same += 1; if (same >= 2) return { ok: true, output: answer }; } else same = 0;
        last = answer;
      }
      return last ? { ok: true, output: last, partial: true } : { ok: false, error: `${spec.name || spec.host} gave no answer in time` };
    },
  };
}

const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
// "add X to the team", "add X to my team", "make X part of the team", "X ko team mein add karo".
export function teamAddCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[?!.]+$/, '').trim();
  let m;
  if ((m = /^(?:add|put|bring)\s+(.+?)\s+(?:to|in|into|on)\s+(?:the|my|our|novi'?s)\s+team$/i.exec(t))) return { tool: 'team_add', args: { name: m[1].trim() } };
  if ((m = /^make\s+(.+?)\s+(?:a\s+)?(?:part|member)\s+of\s+(?:the|my|our)\s+team$/i.exec(t))) return { tool: 'team_add', args: { name: m[1].trim() } };
  if ((m = /^(.+?)\s+ko\s+team\s+(?:mein|me)\s+(?:add|daal|dal)\s*(?:karo|do|kar do)?$/i.exec(t))) return { tool: 'team_add', args: { name: m[1].trim() } };
  return null;
}
