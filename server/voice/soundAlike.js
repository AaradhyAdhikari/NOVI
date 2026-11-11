// Names that sound alike (live 2026-11-11: "open perplexity" was heard 5 times as "public City" /
// "publicity" / "popular city" / "public setting"; the phone's recognizer can't take a word list, so the
// words are fixed after hearing). Only the name after "open / launch / go to …" is fixed, only to a name
// Novi knows (an app, a site, a project), and only when one name is clearly the closest.

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

// How a word sounds, roughly: soft c = s, hard c/k/q/g = k, x = ks, b = p, d = t, v = f, ph = f, no
// vowels after the first letter, no doubled letters. "perplexity" → "prplkst", "publicity" → "plst".
export function soundKey(word) {
  let s = squash(word);
  if (!s) return '';
  s = s.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/[cqg]/g, 'k').replace(/x/g, 'ks')
    .replace(/z/g, 's').replace(/b/g, 'p').replace(/d/g, 't').replace(/v/g, 'f').replace(/w/g, '').replace(/h/g, '');
  const first = s[0];
  const rest = s.slice(1).replace(/[aeiouy]/g, '');
  return (first + rest).replace(/(.)\1+/g, '$1');
}

const ratio = (a, b) => (a.length || b.length ? 1 - distance(a, b) / Math.max(a.length, b.length) : 0);
// Both spellings and sounds: whichever is closer.
export const likeness = (heard, name) => Math.max(ratio(squash(heard), squash(name)), ratio(soundKey(heard), soundKey(name)));

// The one known name the words most likely meant, or null when none is close or two are as close.
export function closestName(heard, names, { min = 0.55, margin = 0.1 } = {}) {
  const h = squash(heard);
  if (h.length < 4) return null;
  const scored = [];
  const seen = new Set();
  for (const name of names || []) {
    const n = squash(name);
    if (n.length < 4 || seen.has(n)) continue;
    seen.add(n);
    if (n === h) return null; // already a known name: nothing to fix
    if (n[0] !== h[0] && soundKey(n)[0] !== soundKey(h)[0]) continue;
    if (Math.abs(n.length - h.length) > Math.max(n.length, h.length) / 2) continue;
    scored.push({ name, score: likeness(heard, name) });
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < min) return null;
  if (next && best.score - next.score < margin) return null;
  return best.name;
}

const LEAD = /^((?:(?:ok(?:ay)?|hey|hi)[,\s]+)?(?:(?:hey )?novi[,\s]+)?(?:(?:can|could|would) you |please )?)/i;
const VERB = /^((?:open|launch|start|run|go to|switch to|visit|browse)\s+(?:the\s+|my\s+)?)(.+?)((?:\s+(?:app|application|website|site|page|on (?:my |the )?(?:laptop|computer|phone)|in (?:chrome|the browser)|please|for me|right now|now))*[.!?]*)$/i;
const KHOLO = /^()(.+?)(\s+(?:kholo|khol do|chalu karo|start karo|open karo)[.!?]*)$/i;

// "open public City" → "open Perplexity" when Perplexity is a name Novi knows. Anything else unchanged.
export function fixOpenWords(text, names, opts = {}) {
  const raw = String(text || '');
  const lead = LEAD.exec(raw)[1];
  const body = raw.slice(lead.length);
  const m = VERB.exec(body) || KHOLO.exec(body);
  if (!m) return raw;
  const target = m[2].trim();
  if (target.split(/\s+/).length > 4) return raw;
  const name = closestName(target, names, opts);
  return name ? `${lead}${m[1]}${name}${m[3]}` : raw;
}

// "I meant Perplexity" / "no, I said X" / "not that, X" right after an open: what they meant (≤ 4 words).
const CORRECTION = /^(?:not that|nope|nahi|wrong|no)?[,.!\s]*(?:(?:i|maine) (?:said|meant|mean|bola|said it'?s)|it'?s|it was|i wanted)?[,\s]*(.+?)[.!?]*$/i;
export function correctionOf(text) {
  const t = String(text || '').trim();
  if (!/^(?:no\b|nope\b|nahi\b|not that\b|wrong\b|i (?:said|meant|mean|wanted)\b|maine bola\b|it'?s\b|it was\b)/i.test(t)) return null;
  const m = CORRECTION.exec(t);
  const what = m?.[1]?.trim();
  if (!what || what.split(/\s+/).length > 4 || /^(?:open|close|play|type)\b/i.test(what)) return null;
  if (/^(?:no|nope|nahi|yes|yeah|ok|okay|cancel|stop|deny|deny it|allow|it|that|this)$/i.test(what)) return null; // card answers stay answers
  return what;
}

// The verb part and the name said after it, as heard ("open " + "publicity"), or null.
export function openTarget(text) {
  const raw = String(text || '');
  const body = raw.slice(LEAD.exec(raw)[1].length);
  const m = VERB.exec(body);
  return m && m[2].trim().split(/\s+/).length <= 4 ? { verb: m[1], target: m[2].trim() } : null;
}
