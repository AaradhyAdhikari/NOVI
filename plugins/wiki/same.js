// "Same thing = one dot" (user, 2026-10-20): NOVI CONTEXT = NOVI, medikiiosk = Medikiosk = MediKiosk AI.
// The note "Same things" in Novi Memory records it (user-editable): "- A = B = C" (one thing),
// "- A ≠ B" (different). Sure matches merge by themselves, less sure ones are asked.

const GENERIC = new Set(['context', 'project', 'projects', 'ai', 'app', 'the', 'website', 'site', 'web', 'folder']);
export const normalize = (name) => String(name || '').normalize('NFKC').toLowerCase()
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w && !GENERIC.has(w)).join('');

// Folders that hold projects are never a project themselves (claude-link CONTAINER, kept in step).
export const isContainerName = (name) => /^(?:documents|my documents|desktop|downloads|onedrive(?: - .*)?|projects|repos|source|github|code|dev|users|ドキュメント|デスクトップ|ダウンロード)$/i.test(String(name || '').trim());

function distance(a, b) {
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

// 'sure' | 'maybe' | null. Short names must match exactly; different numbers are never the same.
export function sameness(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return null;
  if (x === y) return 'sure';
  if ((x.match(/\d+/g) || []).join() !== (y.match(/\d+/g) || []).join()) return null;
  const min = Math.min(x.length, y.length);
  const d = distance(x, y);
  if ((d === 1 && min >= 5) || (d === 2 && min >= 10)) return 'sure';
  if (d <= 3 && min >= 6) return 'maybe';
  return null;
}

// The spelling most names share, then not all-lowercase (a typed-in-a-hurry folder), then the shortest.
export function mainName(names) {
  const count = new Map();
  for (const n of names) count.set(normalize(n), (count.get(normalize(n)) || 0) + 1);
  const best = Math.max(...count.values());
  return names.filter((n) => count.get(normalize(n)) === best)
    .sort((a, b) => Number(a === a.toLowerCase()) - Number(b === b.toLowerCase()) || a.length - b.length)[0];
}

const lower = (s) => String(s).trim().toLowerCase();

// Read top to bottom, later lines win: "- A ≠ B" takes B out of A's group; a later "- A = B" joins them again.
export function parseSame(text) {
  let groups = [];
  let different = [];
  const pairIs = (p, a, b) => (lower(p[0]) === lower(a) && lower(p[1]) === lower(b)) || (lower(p[0]) === lower(b) && lower(p[1]) === lower(a));
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, alias) => alias || t); // Novi Memory links names
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (/≠|!=/.test(m[1])) {
      const [a, b] = m[1].split(/\s*(?:≠|!=)\s*/).map((s) => s?.trim());
      if (!a || !b) continue;
      if (!different.some((p) => pairIs(p, a, b))) different.push([a, b]);
      groups = groups.map((g) => (g.some((n) => lower(n) === lower(a)) ? g.filter((n) => lower(n) !== lower(b)) : g)).filter((g) => g.length > 1);
      continue;
    }
    const names = m[1].split(/\s+=\s+/).map((s) => s.trim()).filter(Boolean);
    if (names.length < 2) continue;
    different = different.filter((p) => !(names.some((n) => lower(n) === lower(p[0])) && names.some((n) => lower(n) === lower(p[1]))));
    const hit = groups.find((g) => g.some((n) => names.some((x) => lower(x) === lower(n))));
    if (hit) { for (const n of names) if (!hit.some((h) => lower(h) === lower(n))) hit.push(n); } else groups.push([...names]);
  }
  return { groups, different };
}

// The line to add for these names (an existing group grows), or null when nothing is new.
export function addSame(text, names) {
  const { groups } = parseSame(text);
  const hit = groups.find((g) => g.some((n) => names.some((x) => lower(x) === lower(n))));
  const all = [...(hit || [])];
  for (const n of names) if (!all.some((a) => lower(a) === lower(n))) all.push(n);
  if ((hit && all.length === hit.length) || all.length < 2) return null;
  return `- ${all.join(' = ')}`;
}

const isDifferent = (known, a, b) => known.different.some(([x, y]) => (lower(x) === lower(a) && lower(y) === lower(b)) || (lower(x) === lower(b) && lower(y) === lower(a)));
const groupOf = (known, name) => known.groups.find((g) => g.some((n) => lower(n) === lower(name)));

// New groups to merge (sure) and pairs to ask about (maybe), from all the names Novi knows.
export function findGroups(names, known) {
  const uniq = []; // capitals alone don't make another name (novi = NOVI)
  for (const n of names) if (n && !uniq.some((u) => lower(u) === lower(n))) uniq.push(n);
  const parent = uniq.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const ask = [];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const [a, b] = [uniq[i], uniq[j]];
      if (isDifferent(known, a, b)) continue;
      const kg = groupOf(known, a);
      if (kg && kg.some((n) => lower(n) === lower(b))) { parent[root(j)] = root(i); continue; }
      const s = sameness(a, b);
      if (s === 'sure') parent[root(j)] = root(i);
      else if (s === 'maybe') ask.push([a, b]);
    }
  }
  const sets = new Map();
  uniq.forEach((n, i) => sets.set(root(i), [...(sets.get(root(i)) || []), n]));
  const merge = [...sets.values()].filter((g) => g.length > 1)
    .filter((g) => !(groupOf(known, g[0]) && g.every((n) => groupOf(known, g[0]).some((k) => lower(k) === lower(n)))))
    .map((g) => ({ main: mainName(g), names: g }));
  const together = (a, b) => merge.some((g) => g.names.includes(a) && g.names.includes(b)) || groupOf(known, a)?.some((n) => lower(n) === lower(b));
  return { merge, ask: ask.filter(([a, b]) => !together(a, b)) };
}
