// Where routines are kept: data/routines/routines.json, at most 20, written whole (temp file + rename).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_ROUTINES = 20;

export function createStore({ file }) {
  const read = () => {
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  let list = read();
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  };
  const low = (s) => String(s || '').trim().toLowerCase();
  const freeName = (name) => {
    const base = String(name || 'Routine').trim().slice(0, 60) || 'Routine';
    const taken = new Set(list.map((r) => low(r.name)));
    if (!taken.has(low(base))) return base;
    for (let n = 2; ; n++) if (!taken.has(low(`${base} (${n})`))) return `${base} (${n})`;
  };
  return {
    list: () => list.map((r) => ({ ...r })),
    get: (id) => list.find((r) => r.id === id) || null,
    add(routine) {
      if (list.length >= MAX_ROUTINES) return { error: `You have ${MAX_ROUTINES} routines; remove one first.` };
      const r = { paused: false, fails: 0, ...routine, id: crypto.randomUUID().slice(0, 8), name: freeName(routine.name), created_at: new Date().toISOString() };
      list.push(r);
      save();
      return { ...r };
    },
    update(id, change) {
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) return null;
      list[i] = { ...list[i], ...change, id };
      save();
      return { ...list[i] };
    },
    remove(id) {
      const n = list.length;
      list = list.filter((r) => r.id !== id);
      if (list.length !== n) save();
      return list.length !== n;
    },
    // Exact name first (any case), then the one name that contains the words.
    byName(name) {
      const q = low(name).replace(/\s+routine$/, '');
      if (!q) return null;
      const exact = list.find((r) => low(r.name) === q);
      if (exact) return { ...exact };
      const some = list.filter((r) => low(r.name).includes(q));
      return some.length === 1 ? { ...some[0] } : null;
    },
  };
}
