// "What happened": one entry per request — what Novi heard, who asked, which way it went (a fast
// command, a direct tool, or the AI), every tool it ran (name, ok/failed, the error, time; never
// the arguments) and the start of the reply. Last 200, kept in data/activity/recent.json, laptop
// only (Settings → Activity, "what went wrong?").
import fs from 'node:fs';
import path from 'node:path';

const MAX = 200;
const cut = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const who = (from) => (from && typeof from === 'object' && from.deviceId ? 'phone' : 'laptop');

export function createActivity({ file, now = Date.now } = {}) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')).slice(-MAX); } catch { /* first run */ }
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(entries));
    } catch { /* the log must never break a request */ }
  }
  const save = () => { if (!timer) { timer = setTimeout(flush, 500); timer.unref?.(); } };
  const finish = (turn, extra) => {
    if (!turn || turn.done) return;
    turn.done = true;
    const { started, done, ...rest } = turn;
    entries.push({ ...rest, ...extra, ms: now() - started });
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    save();
  };

  return {
    begin(text, from) {
      return { at: new Date(now()).toISOString(), started: now(), heard: cut(text, 300), from: who(from), provider: null, tools: [] };
    },
    tool(turn, { name, ok, error, ms }) {
      turn?.tools.push({ name, ok: Boolean(ok), ...(ok ? {} : { error: cut(error || 'failed', 300) }), ms: Math.round(ms || 0) });
    },
    ai(turn, provider) { if (turn) turn.provider = provider || 'AI'; },
    end(turn, reply) {
      if (!turn) return;
      const route = turn.provider ? `AI (${turn.provider})` : turn.tools.length ? 'direct' : 'quick';
      delete turn.provider;
      finish(turn, { route, reply: cut(reply, 300) });
    },
    fail(turn, err) {
      if (!turn) return;
      delete turn.provider;
      finish(turn, { route: 'failed', error: cut(err?.message || err, 300) });
    },
    list(n = 50) { return entries.slice(-n).reverse(); },
    flush,
  };
}

// The last request in words (what Novi says for "what went wrong?").
export function describeTurn(e) {
  if (!e) return "I haven't done anything yet since I started.";
  const heard = `Last time I heard "${e.heard}".`;
  if (e.route === 'failed') return `${heard} It went wrong: ${e.error}`;
  const bad = e.tools.find((t) => !t.ok);
  if (bad) return `${heard} ${bad.name} failed: ${bad.error}`;
  if (e.tools.length) return `${heard} I ran ${e.tools.map((t) => t.name).join(', ')} and it worked. I said: ${e.reply}`;
  return `${heard} I answered ${e.route === 'quick' ? 'right away' : `with the ${e.route}`}: ${e.reply}`;
}
