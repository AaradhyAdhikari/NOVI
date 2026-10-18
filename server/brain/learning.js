import fs from 'node:fs';
import path from 'node:path';

// The learning loop (user, 2026-10-18: "why can't it learn from itself"). Novi notices her own misses —
// you corrected her ("I gave you the path", "no, I meant…"), you asked again in almost the same words
// after an unhelpful answer, or a tool failed — and when the request after a miss works with one quiet
// tool, the words that failed become a shortcut for it, so the first way you said it works next time.
// Every miss is kept (data/learning/learning.json, last 300) for "what did you get wrong this week"
// and a weekly note in Novi Memory, so the patterns can become real fixes.
const MAX = 300;
const REPEAT_MS = 2 * 60_000;
const FIX_MS = 3 * 60_000;
const WEEK_MS = 7 * 24 * 3600_000;
const STOP = new Set('a an the is are to of in on at for my me i you your it this that please can could novi hey ok okay now just and or with from'.split(' '));
const words = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); const inter = [...A].filter((w) => B.has(w)).length; return inter / (new Set([...A, ...B]).size || 1); };
const cut = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

// "No, I meant…", "that's wrong", "I gave you the path", "galat hai", "maine bola tha" — never a bare "no".
const CORRECTION = /^(?:(?:no|nope|nah|nahi|arre|yaar|bro|yes|ya|yeah|haan|but)[,.!]?\s+)*(?:that'?s (?:not|wrong)|not that\b|wrong\b|i (?:said|meant|asked|told you|gave (?:you|u))|you (?:didn'?t|did not|got it wrong|misunderstood|are wrong)|not what i|galat|maine (?:bola|kaha))/i;
export const isCorrection = (text) => CORRECTION.test(String(text || '').trim());

// An answer that didn't do the job: couldn't, sorry, which one, tell me the path…
const UNHELPFUL = /\b(?:couldn'?t|can'?t|cannot|could you (?:tell|give)|tell me the|don'?t have|not sure|which one|sorry|i need the|failed|didn'?t work)\b/i;

// "What did you get wrong this week" / "your mistakes" / "kya galtiyan ki" ("what went wrong" is the
// last request's story, server/activity.js).
export function learningCommand(text) {
  const t = String(text || '').trim();
  return /\b(?:what|which)\b.*\b(?:you|u)\b.*\b(?:get|got)\b.*\bwrong\b/i.test(t)
    || /^(?:(?:tell me|show me|list)\s+)?your mistakes\b/i.test(t)
    || /\bmistakes?\b.*\b(?:you|u)\b.*\b(?:made|make|did)\b/i.test(t)
    || /\bgalti(?:yan|ya|yaan)?\b/i.test(t);
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mondayOf = (d) => { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return dayOf(m); };

export function createLearning({ file, shortcuts = null, now = () => new Date() } = {}) {
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).slice(-MAX); } catch { /* first run */ }
  let prev = null; // the turn before this one
  const save = () => {
    if (saved.length > MAX) saved.splice(0, saved.length - MAX);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(saved, null, 1)); } catch { /* never break a request */ }
  };
  const record = (turn, why, extra = {}) => {
    const m = { at: new Date(turn.at).toISOString(), heard: cut(turn.heard, 200), reply: cut(turn.reply, 200), why, ...extra };
    saved.push(m);
    save();
    return m;
  };
  const failed = (turn) => (turn.tools || []).find((t) => !t.ok);
  const quietRun = (turn) => {
    const runs = turn.runs || [];
    const ok = runs.filter((r) => !r.output?.error);
    return ok.length === 1 && ok.length === runs.length && !ok[0].asked ? ok[0] : null;
  };

  return {
    // After every request: { heard, reply, route, tools: [{ name, ok, error }], runs: [{ tool, args, output, asked }] }.
    observe(input) {
      const turn = { ...input, at: now().getTime() };
      const bad = failed(turn);
      if (bad) record(turn, 'error', { error: cut(`${bad.name}: ${bad.error || 'failed'}`, 160) });
      // Was the request before this one a miss?
      if (prev && turn.at - prev.at <= REPEAT_MS && !prev.missed) {
        const corrected = isCorrection(turn.heard);
        const repeated = !corrected && UNHELPFUL.test(prev.reply) && words(prev.heard).length >= 2 && jaccard(words(prev.heard), words(turn.heard)) >= 0.6;
        if (corrected || repeated) { prev.missed = record(prev, corrected ? 'correction' : 'repeat', corrected ? { said: cut(turn.heard, 200) } : {}); }
      }
      // A miss followed (soon) by a request that worked with one quiet tool and shares its words: learn it.
      const open = [...saved].reverse().find((m) => !m.fixedBy && m.why !== 'error' && turn.at - new Date(m.at).getTime() <= FIX_MS);
      const run = quietRun(turn);
      if (open && run && !bad && words(open.heard).some((w) => words(turn.heard).includes(w))) {
        open.fixedBy = run.tool;
        open.learned = Boolean(shortcuts?.learn(open.heard, run));
        save();
      }
      prev = turn;
    },
    misses: (sinceMs = Infinity) => saved.filter((m) => now().getTime() - new Date(m.at).getTime() <= sinceMs).slice().reverse(),
    summary() {
      const week = this.misses(WEEK_MS);
      if (!week.length) return "I haven't noticed any mistakes this week.";
      const learned = week.filter((m) => m.learned).length;
      const open = week.filter((m) => !m.fixedBy).slice(0, 2);
      const still = open.length ? ` Still wrong: ${open.map((m) => `"${m.heard}"${m.error ? ` (${m.error})` : ''}`).join('; ')}.` : '';
      return `This week I got ${week.length} thing${week.length === 1 ? '' : 's'} wrong and learned from ${learned} of them.${still}`;
    },
    // The weekly note for Novi Memory ("Novi's mistakes"), oldest first.
    weekNote() {
      const week = this.misses(WEEK_MS).reverse();
      const why = (m) => (m.why === 'correction' ? `you corrected me: "${m.said}"` : m.why === 'repeat' ? 'you had to ask again' : m.error);
      const lines = week.map((m) => `- "${m.heard}" → ${m.reply} (${why(m)})${m.fixedBy ? ` — fixed by ${m.fixedBy}${m.learned ? ', learned' : ''}` : ''}`);
      return `## Week of ${mondayOf(now())}\n${lines.join('\n') || '- No mistakes noticed.'}`;
    },
  };
}
