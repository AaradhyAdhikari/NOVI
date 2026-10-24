// A project's code map (graphify's graphify-out/graph.json) read without AI: find a part by its
// spoken name, explain it, find how two parts connect, sum the map up. Test files, package.json
// entries, outside modules and Markdown headings are noise here (live Novi map, 2026-10-24: "vitest" was the top hub
// and a test's setup() the "surprising connection"), so they are left out.
const VERBS = {
  calls: ['calls', 'is called by'],
  indirect_call: ['calls', 'is called by'],
  imports: ['imports', 'is imported by'],
  imports_from: ['imports', 'is imported by'],
  dynamic_import: ['imports', 'is imported by'],
  contains: ['contains', 'is in'],
  method: ['has the method', 'is a method of'],
};
const verb = (relation, forward) => {
  const words = String(relation || 'link').replace(/_/g, ' ');
  return (VERBS[relation] || [words, `is linked (${words}) to`])[forward ? 0 : 1];
};

const isTest = (n) => /(^|\/)(tests?|__tests__|spec)\//i.test(n.source_file || '') || /\.(test|spec)\.[a-z]+$/i.test(n.source_file || '');
const isNoise = (n) => n.external || n.file_type === 'concept' || n.file_type === 'document' || !n.source_file || /(^|\/)package(-lock)?\.json$/i.test(n.source_file);

export function loadGraph(data) {
  const nodes = new Map((data?.nodes || []).map((n) => [n.id, n]));
  const adj = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const l of data?.links || []) {
    if (!nodes.has(l.source) || !nodes.has(l.target) || l.source === l.target) continue;
    adj.get(l.source).push({ id: l.target, relation: l.relation, forward: true });
    adj.get(l.target).push({ id: l.source, relation: l.relation, forward: false });
  }
  return { nodes, adj };
}

// The parts worth talking about: real code, never tests, packages or outside modules.
const kept = (g, id) => { const n = g.nodes.get(id); return Boolean(n) && !isNoise(n) && !isTest(n); };
const degree = (g, id) => g.adj.get(id).filter((l) => kept(g, l.id)).length;

const FILLER = /\b(?:the|a|an|my|our|its|class|function|method|file|part|code|module|thing)\b/gi;
const key = (s) => String(s || '').toLowerCase().replace(/\(\)/g, '').replace(/[^a-z0-9.]+/g, '').replace(/^\.+|\.+$/g, '');

// The best match for what was said: exact name, then starts with, then contains; ties → the more
// connected part, then the shorter name. "module" / "file" in the words puts files first ("the
// vocabulary module" = vocabulary.js, not a variable called vocabulary).
const EXT = /\.[a-z0-9]{1,5}$/i;
export function findNode(g, query) {
  const wantsFile = /\b(?:module|file)\b/i.test(String(query || ''));
  const q = key(String(query || '').replace(FILLER, ' '));
  if (q.length < 2) return null;
  let best = null;
  for (const [id, n] of g.nodes) {
    if (!kept(g, id)) continue;
    const k = key(n.label);
    const isFile = EXT.test(n.label);
    const fileMatch = isFile && key(n.label.replace(EXT, '')) === q;
    const score = wantsFile && fileMatch ? 4 : k === q || fileMatch ? 3 : k.startsWith(q) ? 2 : k.includes(q) ? 1 : 0;
    if (!score) continue;
    const rank = [score, degree(g, id), -k.length];
    const better = !best || (() => { for (let i = 0; i < rank.length; i += 1) if (rank[i] !== best.rank[i]) return rank[i] > best.rank[i]; return false; })();
    if (better) best = { node: n, rank };
  }
  return best ? best.node : null;
}

const lineOf = (n) => Number(String(n.source_location || '').replace(/^L/, '')) || null;

// What a part is linked to: its own calls/imports first, then who uses it (at most `max`).
// users: only the parts that use it ("what uses X").
export function explain(g, id, { max = 8, users = false } = {}) {
  const n = g.nodes.get(id);
  if (!n) return null;
  const links = g.adj.get(id)
    .filter((l) => kept(g, l.id) && (!users || !l.forward))
    .sort((a, b) => Number(b.forward) - Number(a.forward))
    .map((l) => {
      const v = verb(l.relation, l.forward);
      const label = g.nodes.get(l.id).label;
      return { verb: v, label, text: `${v} ${label}`, id: l.id };
    });
  return { id, label: n.label, file: n.source_file, line: lineOf(n), group: n.community_name || null, links: links.slice(0, max), total: links.length, users };
}

const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (v, n) => (n > 1 && v === 'has the method' ? 'has the methods' : v);

// One verb per group ("It has the methods A and B, and calls C."), in the order the links came.
export function explainText(e) {
  const where = `${e.label} is in ${e.file}${e.line ? `, line ${e.line}` : ''}.`;
  if (!e.links.length) return `${where} Nothing else in the map ${e.users ? 'uses' : 'links to'} it.`;
  const groups = new Map();
  for (const l of e.links) groups.set(l.verb, [...(groups.get(l.verb) || []), l.label]);
  const parts = [...groups].map(([v, labels]) => `${plural(v, labels.length)} ${list(labels)}`);
  const more = e.total > e.links.length ? `, and ${e.total - e.links.length} more links` : '';
  return `${where} It ${list(parts)}${more}.`;
}

// Fewest steps from a to b over real code (both directions count), at most `max` steps.
export function shortestPath(g, a, b, { max = 8 } = {}) {
  if (!kept(g, a) || !kept(g, b)) return null;
  if (a === b) return [a];
  const prev = new Map([[a, null]]);
  let frontier = [a];
  for (let step = 0; step < max && frontier.length; step += 1) {
    const next = [];
    for (const u of frontier) {
      for (const { id } of g.adj.get(u)) {
        if (prev.has(id) || !kept(g, id)) continue;
        prev.set(id, u);
        if (id === b) {
          const path = [b];
          while (prev.get(path[0]) !== null) path.unshift(prev.get(path[0]));
          return path;
        }
        next.push(id);
      }
    }
    frontier = next;
  }
  return null;
}

export function pathText(g, path) {
  const label = (id) => g.nodes.get(id).label;
  const steps = path.slice(1).map((v, i) => {
    const u = path[i];
    const l = g.adj.get(u).find((x) => x.id === v);
    return `${label(u)} ${verb(l.relation, l.forward)} ${label(v)}`;
  });
  const n = steps.length;
  return `${label(path[0])} reaches ${label(path.at(-1))} in ${n} step${n === 1 ? '' : 's'}: ${n < 2 ? steps[0] : `${steps.slice(0, -1).join(', ')}, and ${steps.at(-1)}`}.`;
}

export function summary(g, { hubs = 3 } = {}) {
  const ids = [...g.nodes.keys()].filter((id) => kept(g, id));
  let links = 0;
  for (const id of ids) links += g.adj.get(id).filter((l) => l.forward && kept(g, l.id)).length;
  const groups = new Set(ids.map((id) => g.nodes.get(id).community_name ?? g.nodes.get(id).community)).size;
  const top = ids.map((id, i) => ({ id, i, d: degree(g, id) })).sort((x, y) => y.d - x.d || x.i - y.i).slice(0, hubs);
  return { parts: ids.length, links, groups, hubs: top.map((t) => g.nodes.get(t.id).label) };
}
