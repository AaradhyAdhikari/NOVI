// A list of the files you'd ask for by name (documents, sheets, PDFs, slides, code, pictures, folders)
// across the whole laptop, so "open my DBMS notes" finds the right file in well under a second.
// System and app folders are skipped; the list is saved so Novi is ready right after a restart.
import fs from 'node:fs';
import path from 'node:path';

const KINDS = {
  sheet: ['.xlsx', '.xls', '.csv', '.tsv', '.ods'],
  pdf: ['.pdf'],
  doc: ['.docx', '.doc', '.odt', '.pdf', '.md', '.txt'],
  slides: ['.pptx', '.ppt', '.odp'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
};
const WANTED = new Set([...Object.values(KINDS).flat(), '.json', '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.php', '.rb', '.ipynb', '.sql', '.yml', '.yaml', '.sh', '.ps1']);
const SKIP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'msocache', 'appdata', 'application data', 'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'site-packages', '.gradle', '.m2', '.npm', '.nuget', '.cargo', '.rustup', 'temp', 'tmp', 'coverage', 'target', 'obj', '.vscode', '.idea', 'onedrivetemp', 'intel', 'nvidia', 'amd', '$windows.~bt', '$windows.~ws', 'windows.old']);
const KIND_WORDS = { sheet: 'sheet sheets excel spreadsheet spreadsheets csv', pdf: 'pdf', doc: 'doc docx document documents word', slides: 'ppt pptx slides presentation deck', image: 'photo photos image images picture pictures pic pics', folder: 'folder folders directory' };
const KIND_OF = new Map(Object.entries(KIND_WORDS).flatMap(([k, ws]) => ws.split(' ').map((w) => [w, k])));
const STOP = new Set('open opens show me my the a an please file files read summary summarize summarise check find search for of in on from to that this and wala wali ka ki ke kholo kholna dikhao padho'.split(' '));
// "analysis" is only a stop word when other words remain (see queryOf).

const tokens = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function queryOf(text) {
  const all = tokens(text);
  let kind = null;
  const words = [];
  for (const w of all) {
    if (KIND_OF.has(w)) kind = kind || KIND_OF.get(w);
    else if (!STOP.has(w)) words.push(w);
  }
  // Keep "analysis" etc. when they're all that's left to search by.
  if (!words.length) words.push(...all.filter((w) => !KIND_OF.has(w) && !['open', 'my', 'the', 'a', 'please', 'file'].includes(w)));
  return { words, kind };
}

export function defaultRoots({ platform = process.platform, home, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return [home];
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((p) => exists(p));
}

// Sounds alike for speech-to-text slips: same consonants ("sails" ~ "sales", "analisis" ~ "analysis").
const skeleton = (w) => w.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');

function close(a, b) {
  if (a.length >= 4 && b.length >= 4 && skeleton(a).length >= 2 && skeleton(a) === skeleton(b)) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  const max = a.length >= 7 ? 2 : a.length >= 4 ? 1 : 0;
  if (!max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}

export function createFileIndex({ roots, home = '', file, maxEntries = 500_000, now = () => Date.now() }) {
  let list = []; // { path, name (lower, no extension), ext, mtime, dir }
  const homeLower = String(home).toLowerCase();

  async function build() {
    const found = [];
    let n = 0;
    const visit = async (dir, depth) => {
      if (depth > 14 || found.length >= maxEntries) return;
      let handle;
      try { handle = await fs.promises.opendir(dir); } catch { return; }
      for await (const e of handle) {
        if (found.length >= maxEntries) break;
        const full = path.join(dir, e.name);
        if (++n % 2000 === 0) await new Promise((r) => setImmediate(r)); // stay responsive while scanning
        if (e.isDirectory()) {
          const lower = e.name.toLowerCase();
          if (SKIP.has(lower) || (lower.startsWith('.') && lower !== '.')) continue;
          found.push({ path: full, name: lower, ext: '', mtime: 0, dir: true });
          await visit(full, depth + 1);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (!WANTED.has(ext)) continue;
          let mtime = 0;
          try { mtime = (await fs.promises.stat(full)).mtimeMs; } catch { /* gone */ }
          found.push({ path: full, name: e.name.slice(0, e.name.length - ext.length).toLowerCase(), ext, mtime, dir: false });
        }
      }
    };
    for (const root of roots) await visit(root, 0);
    list = found;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ builtAt: now(), entries: list }));
      } catch { /* best effort */ }
    }
    return list.length;
  }

  function load() {
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8')).entries || [];
      return list.length > 0;
    } catch {
      return false;
    }
  }

  function search(text, { limit = 5 } = {}) {
    const { words, kind } = queryOf(text);
    if (!words.length) return [];
    const exts = kind && kind !== 'folder' ? KINDS[kind] : null;
    const results = [];
    for (const e of list) {
      const nameTokens = tokens(e.name);
      let score = 0;
      let missed = 0;
      for (const w of words) {
        if (nameTokens.includes(w)) score += 3;
        else if (nameTokens.some((t) => t.startsWith(w) || w.startsWith(t) && t.length >= 3)) score += 2;
        else if (e.name.replace(/[^\p{L}\p{N}]/gu, '').includes(w)) score += 1.5;
        else if (nameTokens.some((t) => close(w, t))) score += 1.2;
        else missed += 1;
      }
      if (missed > (words.length >= 3 ? 1 : 0)) continue;
      if (kind === 'folder') score += e.dir ? 3 : -2;
      else if (exts) score += exts.includes(e.ext) ? 3 : -2;
      const age = (now() - e.mtime) / 86400000;
      if (!e.dir) score += age < 7 ? 1 : age < 30 ? 0.5 : 0;
      if (homeLower && e.path.toLowerCase().startsWith(homeLower)) score += 0.5;
      score -= e.path.split(/[\\/]/).length * 0.02;
      results.push({ entry: e, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit)
      .map(({ entry }) => ({ path: entry.path, name: path.basename(entry.path), dir: entry.dir, modified: entry.mtime ? new Date(entry.mtime).toISOString().slice(0, 10) : null }));
  }

  return { build, load, search, entries: () => list.slice(), size: () => list.length };
}
