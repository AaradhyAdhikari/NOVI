// The team: every agent is one adapter { id, name, aliases, roles, order, available(), run(pkg, ctx) }.
// Adding an agent = adding an adapter; nothing else changes. pick(role) takes the user's named agent
// first, skips the ones they ruled out, and says what it could not do (a gap) instead of guessing.
import { closestName } from '../../server/voice/soundAlike.js';
import { roleVerb, squashId } from './roles.js';

export function createRegistry() {
  const agents = [];
  const find = (name) => {
    const key = squashId(name);
    if (!key) return null;
    for (const a of agents) if (a.id === key || squashId(a.name) === key || (a.aliases || []).some((x) => squashId(x) === key)) return a;
    const all = agents.flatMap((a) => [a.name, ...(a.aliases || [])]);
    const near = closestName(String(name), all, { min: 0.7, margin: 0.1 });
    return near ? agents.find((a) => a.name === near || (a.aliases || []).includes(near)) || null : null;
  };
  const can = async (a) => { try { const r = await a.available(); return r === true ? { ok: true } : r || { ok: false, why: `${a.name} is not available` }; } catch (err) { return { ok: false, why: `${a.name}: ${err.message}` }; } };
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
    async pick(role, { prefer = [], avoid = [] } = {}) {
      const avoided = new Set(avoid.map(squashId));
      const gaps = [];
      const tried = [];
      const sayWhy = (a, r) => gaps.push(r.why || `${a.name} is not available`);
      for (const p of prefer) {
        const a = find(p);
        if (!a) { gaps.push(`I don't have an agent called ${p}`); continue; }
        if (avoided.has(a.id)) continue;
        if (!a.roles.includes(role)) { gaps.push(`${a.name} can't ${roleVerb(role)}`); continue; }
        tried.push(a.id);
        const r = await can(a);
        if (r.ok) return { agent: a, gap: gaps.join('. ') || null, tried };
        sayWhy(a, r);
      }
      for (const a of this.list()) {
        if (avoided.has(a.id) || !a.roles.includes(role) || tried.includes(a.id)) continue;
        tried.push(a.id);
        const r = await can(a);
        if (r.ok) return { agent: a, gap: gaps.join('. ') || null, tried };
        sayWhy(a, r);
      }
      return { agent: null, gap: gaps.join('. ') || `Nobody on the team can ${roleVerb(role)}`, tried };
    },
    async status() {
      const out = [];
      for (const a of this.list()) { const r = await can(a); out.push({ id: a.id, name: a.name, roles: a.roles, ok: r.ok, why: r.ok ? '' : r.why }); }
      return out;
    },
  };
}
