// The team's track record (2026-11-12): what really happened to each coder's work, per difficulty, from the
// user's own cards (approved = pass, sent back = back) and failures. Public benchmarks go stale and the free
// model list changes weekly; this learns from the user's real work instead. data/agents/record.json.
import fs from 'node:fs';
import path from 'node:path';

const KINDS = ['pass', 'back', 'fail'];

export function createRecord({ file = null } = {}) {
  let data = {};
  try { if (file) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); } catch { /* a lost count never breaks a run */ }
  };
  const stats = (agent, level = 'medium') => {
    const s = data[agent]?.[level] || {};
    const pass = s.pass || 0;
    const tries = KINDS.reduce((n, k) => n + (s[k] || 0), 0);
    return { pass, back: s.back || 0, fail: s.fail || 0, tries, rate: tries ? pass / tries : null };
  };
  return {
    note(agent, level, kind) {
      if (!agent || !KINDS.includes(kind)) return;
      const lv = level || 'medium';
      data[agent] ??= {};
      data[agent][lv] ??= {};
      data[agent][lv][kind] = (data[agent][lv][kind] || 0) + 1;
      save();
    },
    stats,
    // How much earlier (negative) or later (positive) this coder should come for this level.
    // Strong (≥ 80 % over ≥ 5): 30 earlier. Weak (< 40 % over ≥ 3): 100 later (behind everyone who fits).
    nudge(agent, level) {
      const s = stats(agent, level);
      if (s.tries >= 5 && s.rate >= 0.8) return -30;
      if (s.tries >= 3 && s.rate < 0.4) return 100;
      return 0;
    },
    all: () => JSON.parse(JSON.stringify(data)),
  };
}
