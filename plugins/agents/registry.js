// The team: every agent is one adapter { id, name, aliases, roles, order, available(), run(pkg, ctx) }.
// Adding an agent = adding an adapter; nothing else changes. pick(role) takes the user's named agent
// first, skips the ones they ruled out, and says what it could not do (a gap) instead of guessing.
import { closestName } from '../../server/voice/soundAlike.js';
import { roleVerb, squashId } from './roles.js';

// record: the team's track record (record.js), which moves coders earlier or later per difficulty.
export function createRegistry({ record = null } = {}) {
  const agents = [];
  // Build coders say how early they come per level ({ easy: 10, medium: 40 }); a level they don't list,
  // they don't take (unless named). Text agents have no levels and keep their plain order.
  const rank = (a, level) => {
    if (!a.levels) return a.order;
    const base = a.levels[level];
    return base == null ? null : base + (record?.nudge?.(a.id, level) || 0);
  };
  const find = (name) => {
    const key = squashId(name);
    if (!key) return null;
    for (const a of agents) if (squashId(a.id) === key || squashId(a.name) === key || (a.aliases || []).some((x) => squashId(x) === key)) return a;
    const all = agents.flatMap((a) => [a.name, ...(a.aliases || [])]);
    const near = closestName(String(name), all, { min: 0.7, margin: 0.1 });
    return near ? agents.find((a) => a.name === near || (a.aliases || []).includes(near)) || null : null;
  };
  const can = async (a, ctx = {}) => { try { const r = await a.available(ctx); return r === true ? { ok: true } : r || { ok: false, why: `${a.name} is not available` }; } catch (err) { return { ok: false, why: `${a.name}: ${err.message}` }; } };
  return {
    add(adapter) {
      if (!adapter?.id || !Array.isArray(adapter.roles) || typeof adapter.run !== 'function') throw new Error('An agent needs an id, roles and run().');
      const i = agents.findIndex((a) => a.id === adapter.id);
      const full = { aliases: [], order: 50, available: async () => ({ ok: true }), ...adapter };
      if (i >= 0) agents[i] = full; else agents.push(full);
    },
    list: () => [...agents].sort((a, b) => a.order - b.order),
    names: () => agents.map((a) => a.name),
    find,
    // Who can do this role right now: the user's named agent first (a gap if it can't), then the team in
    // order, never one the user ruled out. gap: what was skipped and why (said to the user).
    // level: the build step's difficulty (older tasks without one count as medium); project: for agents
    // that ask before seeing a project (free models).
    async pick(role, { prefer = [], avoid = [], level = null, project = null } = {}) {
      const avoided = new Set(avoid.map(squashId));
      const lv = level || 'medium';
      const ctx = { project, level: lv };
      const gaps = [];
      const tried = [];
      const sayWhy = (a, r) => gaps.push(r.why || `${a.name} is not available`);
      for (const p of prefer) {
        const a = find(p);
        if (!a) { gaps.push(`I don't have an agent called ${p}`); continue; }
        if (avoided.has(squashId(a.id))) continue;
        if (!a.roles.includes(role)) { gaps.push(`${a.name} can't ${roleVerb(role)}`); continue; }
        tried.push(a.id);
        const r = await can(a, ctx);
        if (r.ok) return { agent: a, gap: gaps.join('. ') || null, tried };
        sayWhy(a, r);
      }
      const order = this.list().filter((a) => a.roles.includes(role)).map((a) => ({ a, r: rank(a, lv) })).filter((x) => x.r != null).sort((x, y) => x.r - y.r).map((x) => x.a);
      for (const a of order) {
        if (avoided.has(squashId(a.id)) || tried.includes(a.id)) continue;
        tried.push(a.id);
        const r = await can(a, ctx);
        if (r.ok) return { agent: a, gap: gaps.join('. ') || null, tried };
        sayWhy(a, r);
      }
      return { agent: null, gap: gaps.join('. ') || `Nobody on the team can ${roleVerb(role)}`, tried };
    },
    async status() {
      const out = [];
      for (const a of this.list()) { const r = await can(a); out.push({ id: a.id, name: a.name, roles: a.roles, levels: a.levels ? Object.keys(a.levels) : null, ok: r.ok, why: r.ok ? '' : r.why }); }
      return out;
    },
  };
}
