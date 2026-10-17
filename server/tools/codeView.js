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
const STOP = new Set(('show me the code of file my a an please in for part section where is it its this that wala wali ka ki ke dikha dikhao do de see let look at which written you wrote just '
  + 'coder novi claude hey okay ok can could give send page app website site project we were are was our building built made making whole full entire').split(' '));
const WINDOW = 40;
const BLOCK_MAX = 300; // a part (an HTML element, a function, a CSS rule) longer than this gets the window
const FULL = /\b(full|whole|entire|complete)\b/i;
const FULL_MAX = 600; // "the full code of index.html": the whole file up to this many lines
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;

// The whole part that starts at line `at` (0-based): <tag>…</tag>, { … } or a Python block. null = can't tell.
function blockAt(lines, at, file) {
  const first = lines[at];
  const tag = /^\s*<([a-zA-Z][\w-]*)/.exec(first)?.[1];
  if (tag) {
    if (VOID.test(tag)) return lines.slice(at, at + 1);
    const open = new RegExp(`<${tag}(?=[\\s>/]|$)(?![^>]*/>)`, 'gi');
    const close = new RegExp(`</${tag}\\s*>`, 'gi');
    let depth = 0;
    for (let i = at; i < lines.length && i - at < BLOCK_MAX; i++) {
      depth += (lines[i].match(open) || []).length - (lines[i].match(close) || []).length;
      if (depth <= 0) return lines.slice(at, i + 1);
    }
    return null;
  }
  if (/\.py$/i.test(file) && /:\s*(#.*)?$/.test(first)) {
    const indent = first.match(/^\s*/)[0].length;
    let end = at;
    for (let i = at + 1; i < lines.length && i - at < BLOCK_MAX; i++) {
      if (!lines[i].trim()) continue;
      if (lines[i].match(/^\s*/)[0].length <= indent) break;
      end = i;
    }
    return lines.slice(at, end + 1);
  }
  let depth = 0;
  let opened = false;
  for (let i = at; i < lines.length && i - at < BLOCK_MAX; i++) {
    for (const c of lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) {
      if (c === '{') { depth += 1; opened = true; } else if (c === '}') depth -= 1;
    }
    if (opened && depth <= 0) return lines.slice(at, i + 1);
    if (!opened && i - at >= 2) return null;
  }
  return null;
}

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
// whole: a file of at most this many lines comes back whole (start 1) when the match is the file
// itself (by name or language), not a definition inside it — the chat's edit card shows all of it.
export function findCode(root, query, { recent = [], whole = 0 } = {}) {
  const words = (String(query || '').toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) || []).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter(Boolean);
  const exts = words.flatMap((w) => LANG[w] || []);
  const terms = words.filter((w) => !LANG[w] && !STOP.has(w) && w.length >= 3)
    .flatMap((w) => (w.length > 4 && w.endsWith('s') ? [w, w.slice(0, -1)] : [w])); // "contacts" → contact.html
  const recentFirst = [...recent].reverse().map((f) => path.resolve(root, f));
  const all = walk(root);
  // Shallowest first; at the same depth the entry file (index / main / App) comes first.
  const entry = (f) => (/^(index|main|app)\./i.test(path.basename(f)) ? 0 : 1);
  const order = [...new Set([...recentFirst.filter((f) => all.includes(f)), ...all.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || entry(a) - entry(b) || a.localeCompare(b))])];
  const pool = exts.length ? order.filter((f) => exts.includes(path.extname(f).toLowerCase())) : order;
  if (!pool.length) return null;
  const wholeUpTo = FULL.test(String(query || '')) ? Math.max(whole, FULL_MAX) : whole;
  const result = (file, at, itself = false, def = false) => {
    const lines = read(file) || [];
    if (itself && wholeUpTo && lines.length <= wholeUpTo) return { file: path.relative(root, file), start: 1, lines, total: lines.length };
    // Where a thing is defined: that whole thing ("the header" = <header>…</header>), not a window.
    const block = def ? blockAt(lines, at - 1, file) : null;
    if (block) return { file: path.relative(root, file), start: at, lines: block, total: lines.length };
    const start = Math.max(1, at - 10);
    return { file: path.relative(root, file), start, lines: lines.slice(start - 1, start - 1 + WINDOW), total: lines.length };
  };
  if (terms.length) {
    // A file named after the thing first ("navbar" → Navbar.jsx), then where it's defined, then any mention.
    const named = pool.find((f) => terms.some((t) => path.basename(f).toLowerCase().includes(t)));
    if (named) return result(named, 1, true);
    let mention = null;
    for (const f of pool) {
      const lines = read(f);
      if (!lines) continue;
      // A definition, an element (<header, id="contact"), or a CSS rule (.site-footer {).
      const def = lines.findIndex((l) => terms.some((t) => {
        const q = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(function|class|const|let|var|def|id=|class=|<)\\s*["']?${q}`, 'i').test(l) || new RegExp(`^\\s*[.#]${q}\\b`, 'i').test(l);
      }));
      if (def >= 0) return result(f, def + 1, false, true);
      if (!mention) {
        const any = lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t)));
        if (any >= 0) mention = [f, any + 1];
      }
    }
    if (mention) return result(...mention);
    if (!exts.length) return null;
  }
  return result(pool[0], 1, true);
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
