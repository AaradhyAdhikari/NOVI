// A Claude plan in short, for the card (user, 2026-11-05: "How would I know what are the 30 steps"): its
// name, what you get, and the real steps. Plans are full of bullets that aren't steps, so the numbered
// list counts first, then the sections, and bare bullets only when there is nothing else.
const MAX_STEPS = 12;
const plain = (s) => String(s).replace(/\*\*|`/g, '').trim();
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const NOT_A_STEP = /^(context|background|overview|summary|goal|outcome|notes?)\b/i;

export function planSummary(plan) {
  const lines = String(plan || '').split(/\r?\n/);
  const match = (re) => lines.map((l) => re.exec(l)?.[1]).filter(Boolean).map(plain);
  const numbered = match(/^\d+[.)]\s+(.+)$/);
  const sections = match(/^##\s+(.+)$/).filter((s) => !NOT_A_STEP.test(s));
  const bullets = match(/^[-*•]\s+(.+)$/);
  const all = numbered.length ? numbered : sections.length ? sections : bullets;
  const title = cut(match(/^#\s+(.+)$/)[0] || '', 80);
  if (!all.length && !title) return null;
  return {
    title,
    summary: cut(match(/^\*\*Outcome:?\*\*:?\s*(.+)$/i)[0] || '', 200),
    steps: all.slice(0, MAX_STEPS).map((s) => cut(s, 110)),
    count: all.length,
    more: Math.max(0, all.length - MAX_STEPS),
  };
}

// Read out short (user, 2026-10-28); the steps are on the card.
export function planLine(name, project, p) {
  if (!p) return `${name}'s plan for ${project} is ready. Go ahead?`;
  const parts = [p.title, p.count ? `${p.count} step${p.count === 1 ? '' : 's'}` : ''].filter(Boolean);
  return `${name}'s plan for ${project}: ${parts.join('. ')}. Go ahead?`;
}
