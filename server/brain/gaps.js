import fs from 'node:fs';
import path from 'node:path';

// Requests no rule caught (smart routing, 2026-11-11): what was said and what the quick AI picked. Read by
// "what didn't you understand" and the weekly note, so the common ones can get a fast rule. Last 500 kept.
const KEEP = 500;

export function createGaps({ file, now = Date.now } = {}) {
  const read = () => {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return {
    record({ heard, picked = [] }) {
      if (!file || !String(heard || '').trim()) return;
      try {
        const rows = [...read(), { at: new Date(now()).toISOString(), heard: String(heard).slice(0, 200), picked }].slice(-KEEP);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      } catch { /* the log never breaks a reply */ }
    },
    list: (days = 7) => read().filter((r) => now() - Date.parse(r.at) < days * 86_400_000),
    summary(days = 7) {
      const rows = this.list(days);
      if (!rows.length) return `Nothing slipped past my rules in the last ${days} days.`;
      const counts = new Map();
      for (const r of rows) for (const t of r.picked) counts.set(t, (counts.get(t) || 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} (${n})`);
      const lost = rows.filter((r) => !r.picked.length).slice(-3).map((r) => `"${r.heard}"`);
      return [
        `${rows.length} requests in the last ${days} days had no ready rule.`,
        top.length ? `Most often they needed: ${top.join(', ')}.` : '',
        lost.length ? `I had nothing for: ${lost.join(', ')}.` : '',
      ].filter(Boolean).join(' ');
    },
  };
}
