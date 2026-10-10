// "Show me the HTML code" / "show me the navbar code": find the exact code in the project and draw it
// as a picture (SVG) for the phone or the laptop. Read-only.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cache']);
const TEXT = /\.(html?|css|scss|js|jsx|mjs|cjs|ts|tsx|json|md|py|java|c|cpp|h|cs|go|rs|php|rb|kt|swift|vue|svelte|sql|sh|ps1|yml|yaml|toml|xml|txt)$/i;
const LANG = {
  html: ['.html', '.htm'], css: ['.css', '.scss'], scss: ['.scss'], javascript: ['.js', '.jsx', '.mjs'], js: ['.js', '.jsx', '.mjs'],
  react: ['.jsx', '.tsx'], jsx: ['.jsx'], typescript: ['.ts', '.tsx'], ts: ['.ts', '.tsx'], python: ['.py'], py: ['.py'],
  java: ['.java'], json: ['.json'], rust: ['.rs'], go: ['.go'], php: ['.php'], sql: ['.sql'], markdown: ['.md'], readme: ['.md'],
};
const STOP = new Set('show me the code of file my a an please in for part section where is it its this that wala wali ka ki ke dikha dikhao do de see let look at which written you wrote just'.split(' '));
const WINDOW = 40;

function walk(root) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > 8 || out.length > 3000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) visit(path.join(dir, e.name), depth + 1); }
      else if (TEXT.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  visit(root, 0);
  return out;
}

const read = (file) => {
  try { return fs.statSync(file).size > 400_000 ? null : fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return null; }
};

// → { file (relative), start (1-based), lines } | null
export function findCode(root, query, { recent = [] } = {}) {
  const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) || [];
  const exts = words.flatMap((w) => LANG[w] || []);
  const terms = words.filter((w) => !LANG[w] && !STOP.has(w) && w.length >= 3);
  const recentFirst = [...recent].reverse().map((f) => path.resolve(root, f));
  const all = walk(root);
  const order = [...new Set([...recentFirst.filter((f) => all.includes(f)), ...all.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))])];
  const pool = exts.length ? order.filter((f) => exts.includes(path.extname(f).toLowerCase())) : order;
  if (!pool.length) return null;
  const result = (file, at) => {
    const lines = read(file) || [];
    const start = Math.max(1, at - 10);
    return { file: path.relative(root, file), start, lines: lines.slice(start - 1, start - 1 + WINDOW) };
  };
  if (terms.length) {
    // A file named after the thing first ("navbar" → Navbar.jsx), then where it's defined, then any mention.
    const named = pool.find((f) => terms.some((t) => path.basename(f).toLowerCase().includes(t)));
    if (named) return result(named, 1);
    let mention = null;
    for (const f of pool) {
      const lines = read(f);
      if (!lines) continue;
      const def = lines.findIndex((l) => terms.some((t) => new RegExp(`(function|class|const|let|var|def|id=|class=|<)\\s*["']?${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(l)));
      if (def >= 0) return result(f, def + 1);
      if (!mention) {
        const any = lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t)));
        if (any >= 0) mention = [f, any + 1];
      }
    }
    if (mention) return result(...mention);
    if (!exts.length) return null;
  }
  return result(pool[0], 1);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function codeSvg({ file, start, lines }) {
  const lh = 18;
  const top = 40;
  const shown = lines.map((l) => String(l).replace(/\t/g, '  ')).map((l) => (l.length > 110 ? `${l.slice(0, 109)}…` : l));
  const width = Math.max(420, 70 + 7.8 * Math.max(20, ...shown.map((l) => l.length)));
  const height = top + shown.length * lh + 14;
  const rows = shown.map((l, i) => {
    const y = top + (i + 1) * lh - 4;
    return `<text x="44" y="${y}" text-anchor="end" fill="#6e7681">${start + i}</text><text x="56" y="${y}" xml:space="preserve" fill="#e6edf3">${esc(l)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${height}" viewBox="0 0 ${Math.round(width)} ${height}" font-family="Consolas, 'Courier New', monospace" font-size="13">`
    + `<rect width="100%" height="100%" rx="8" fill="#0d1117"/>`
    + `<text x="16" y="25" fill="#7ee787" font-size="14">${esc(file)} · lines ${start}–${start + Math.max(0, shown.length - 1)}</text>`
    + rows.join('') + '</svg>';
}
