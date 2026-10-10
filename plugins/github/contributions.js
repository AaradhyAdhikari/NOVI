// The public contribution graph (github.com/users/<login>/contributions — no sign-in needed),
// read into days and drawn as a picture (SVG) so Novi can send "just the graph" plus a summary.

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

export function parseContributions(html) {
  const tips = new Map();
  for (const m of String(html).matchAll(/<tool-tip\b([^>]*)>([^<]*)<\/tool-tip>/g)) {
    const id = attr(m[1], 'for');
    if (id) tips.set(id, m[2].trim());
  }
  const days = [];
  for (const m of String(html).matchAll(/<td\b[^>]*\sdata-date="[^"]*"[^>]*>/g)) {
    const tag = m[0];
    const tip = tips.get(attr(tag, 'id')) || '';
    const count = Number((/^([\d,]+) contributions?/.exec(tip)?.[1] || attr(tag, 'data-count') || '0').replace(/,/g, ''));
    days.push({ date: attr(tag, 'data-date'), level: Number(attr(tag, 'data-level') || 0), count });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const total = /([\d,]+)\s+contributions?\s+in the last year/.exec(String(html))?.[1];
  return { days, total: total ? Number(total.replace(/,/g, '')) : days.reduce((n, d) => n + d.count, 0) };
}

export async function fetchContributions(login, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://github.com/users/${encodeURIComponent(login)}/contributions`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Novi', Accept: 'text/html' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`GitHub has no user called ${login}.`);
  if (!res.ok) throw new Error(`GitHub didn't send the graph (${res.status}).`);
  const parsed = parseContributions(await res.text());
  if (!parsed.days.length) throw new Error("I couldn't read the contribution graph from GitHub.");
  return parsed;
}

const COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// GitHub's layout: one column per week (Sunday on top), five green levels.
export function graphSvg({ login, days, total, highlight }) {
  const cell = 11;
  const step = 14;
  const left = 16;
  const top = 44;
  const first = new Date(`${days[0].date}T00:00:00Z`);
  const offset = first.getUTCDay();
  const rects = days.map((d, i) => {
    const n = i + offset;
    const x = left + Math.floor(n / 7) * step;
    const y = top + (n % 7) * step;
    const mark = d.date === highlight ? ' stroke="#f78166" stroke-width="2"' : '';
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${COLORS[Math.min(4, Math.max(0, d.level))]}"${mark}><title>${d.count} on ${d.date}</title></rect>`;
  });
  const weeks = Math.ceil((days.length + offset) / 7);
  const width = left * 2 + weeks * step;
  const height = top + 7 * step + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="100%" height="100%" rx="8" fill="#ffffff"/>`
    + `<text x="${left}" y="27" font-family="Segoe UI, Arial, sans-serif" font-size="15" fill="#1f2328">${esc(login)} · ${total.toLocaleString('en-US')} contributions in the last year</text>`
    + rects.join('') + '</svg>';
}
