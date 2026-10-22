import path from 'node:path';

// Searching the brain, and the design rule (user, 2026-10-18): never send all memory to the AI — search,
// take only the evidence this request needs (≤ 6 passages, ≤ 1,500 characters, each with its source).
const STOP = new Set(('a an the is are was were be been am do does did done to of in on at for from with about and or not no it its this that these those ' +
  'what whats when where which who whom why how can could would should will shall may might must have has had i me my mine we our you your ' +
  'he she they them his her their there here tell show find give get please novi hey okay ok write wrote written say said know any some all ' +
  'kya hai hain ka ki ke ko mein me mera meri mere kab kaha kahan kaise ' +
  // Command words say what to do, not what to look for, and "open*" matched nearly every passage (2026-10-22).
  'open close start launch play browse visit go run search check see look list send set turn put take website site page link now right laptop chrome browser').split(' '));
const MAX_PASSAGES = 6;
const MAX_CHARS = 1500;
const SNIPPET = 280;

export const queryWords = (text) => [...new Set((String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 2 && !STOP.has(w)))];

// The words of an item a query matched (prefix match, like the search itself).
const matchedIn = (words, hay) => {
  const tokens = new Set((String(hay || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
  return words.filter((w) => [...tokens].some((t) => t.startsWith(w))).length;
};

// A window of the chunk around the first word the query matched.
function snippetOf(text, words) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= SNIPPET) return t;
  const lower = t.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), t.length);
  const start = Math.max(0, Math.min(at - 60, t.length - SNIPPET));
  return `${start ? '…' : ''}${t.slice(start, start + SNIPPET).trim()}…`;
}

export function searchBrain(store, query, { project = null, limit = 6 } = {}) {
  const words = queryWords(query);
  if (!words.length) return [];
  const match = words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  const rows = store.db.prepare(`SELECT c.item_id AS id, c.text AS text, i.kind AS kind, i.title AS title, i.path AS path, i.project AS project, i.mtime AS mtime,
      bm25(chunks, 0, 0, 8, 2, 1) AS rank
    FROM chunks c JOIN items i ON i.id = c.item_id
    WHERE chunks MATCH ? ${project ? 'AND i.project = ?' : ''}
    ORDER BY rank LIMIT 80`).all(...(project ? [match, project] : [match]));
  const best = new Map();
  const phrase = words.join(' ');
  for (const r of rows) {
    const name = String(r.title || '').toLowerCase().replace(/\.[^.]+$/, '');
    const matched = matchedIn(words, `${r.title} ${r.text}`);
    let score = -r.rank + matched * 2;
    if (name === phrase) score += 20;
    else if (name.startsWith(words[0])) score += 4;
    if (r.kind === 'project' && name === phrase) score += 5;
    const prev = best.get(r.id);
    if (!prev || score > prev.score) best.set(r.id, { id: r.id, kind: r.kind, title: r.title, path: r.path, project: r.project, matched, score, snippet: snippetOf(r.text || r.title, words) });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Keyword hits + meaning hits (the local model), fused by rank. A passage found only by meaning must be
// close enough (the model's own minSim). No model yet, or it fails → keyword hits only.
export async function hybridSearch(store, query, { embedder = null, project = null, limit = 6 } = {}) {
  let qv = null;
  try { if (embedder?.ready?.()) [qv] = (await embedder.embed([query], 'query')) || []; } catch { qv = null; }
  return fusedSearch(store, query, qv, { project, limit, minSim: embedder?.minSim });
}

// The same with the query's meaning vector already made (qv, or null = keywords only) — what the search
// worker runs on its own connection.
export function fusedSearch(store, query, qv, { project = null, limit = 6, minSim = 0.83 } = {}) {
  minSim ??= 0.83;
  const kw = searchBrain(store, query, { project, limit: 20 });
  if (!qv) return kw.slice(0, limit);
  const words = queryWords(query);
  const fused = new Map(kw.map((h, r) => [h.id, { ...h, rrf: 1 / (60 + r) }]));
  store.nearest(qv, 20, project).forEach((n, r) => {
    const cur = fused.get(n.item_id);
    if (cur) { cur.rrf += 1 / (60 + r); cur.sim = Math.max(cur.sim || 0, n.sim); return; }
    if (n.sim < minSim) return;
    const item = store.get(n.item_id);
    if (item) fused.set(n.item_id, { id: item.id, kind: item.kind, title: item.title, path: item.path, project: item.project, matched: 0, score: 0, sim: n.sim, snippet: snippetOf(store.chunkText(n.chunk), words), rrf: 1 / (60 + r) });
  });
  return [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit).map(({ rrf, ...h }) => ({ ...h, close: (h.sim || 0) >= minSim }));
}

// Words that point at the user's own things ("my", "notes", "where is", "meri file"…).
const OWN = /\b(?:my|mine|i|me|i'?m|i'?ve|our|meri|mera|mere|maza|majha|maazi|notes?|files?|folders?|projects?|documents?|docs?|readme|brief|where|find|wrote|written|saved|submission|assignment|exam|resume|cv)\b/i;

// The evidence for one AI turn, or '' when the words aren't about the user's own things or nothing
// matches well enough (at least 2 of the query's words, or its only word).
export function namedProject(prompt, projects = []) {
  const lower = String(prompt || '').toLowerCase();
  return projects.find((p) => p && new RegExp(`(?<![\\p{L}\\p{N}])${p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(lower)) || null;
}
// A command ("open my github profile", "play my playlist") is something to do, not a question about your
// files: it never waits for a search (live 2026-10-22: that search held "open my github profile" for seconds).
const ACTION = /^\s*(?:(?:ok(?:ay)?|hey novi|novi|please|can you|could you|now)[,\s]+)*(?:open|close|play|pause|resume|stop|start|launch|turn|set|go to|send|message|text|call|search|google|browse|visit|mute|unmute|lock|shut|restart|switch)\b/i;
export const aboutOwnThings = (prompt, projects = []) => !ACTION.test(String(prompt || '')) && (OWN.test(String(prompt || '')) || Boolean(namedProject(prompt, projects)));

// hits: already searched (hybridSearch, with meaning); else a keyword search here.
export function contextFor(store, prompt, { projects = [], hits: given = null } = {}) {
  const text = String(prompt || '');
  const named = namedProject(text, projects);
  if (!OWN.test(text) && !named) return { text: '', count: 0 };
  const words = queryWords(text);
  const need = Math.min(2, words.length);
  const hits = (given || searchBrain(store, text, { project: named || null, limit: 12 })).filter((h) => h.matched >= need || h.close);
  const lines = [];
  let used = 0;
  for (const h of hits) {
    if (lines.length >= MAX_PASSAGES) break;
    const where = h.kind === 'note' ? 'note' : h.kind === 'project' ? `project folder ${h.path || ''}`.trim() : shortPath(h.path);
    const line = `- ${h.title} (${where}): ${h.snippet}`;
    if (used + line.length > MAX_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length ? { text: `From your files and notes (use only if relevant):\n${lines.join('\n')}`, count: lines.length } : { text: '', count: 0 };
}

const shortPath = (p) => { const parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts.slice(-3, -1).join(path.sep) || p; };
