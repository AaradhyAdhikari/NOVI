import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// What the AI sites are told about the project, gathered without any AI: the README, package.json,
// a short file list and the last commits, plus the last brief. Names only — never .env or data.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.next', 'out', 'coverage', '.venv', 'venv', '__pycache__', '.cache']);
const skip = (name) => SKIP.has(name) || /^\.env/i.test(name);

function fileList(dir, max = 60) {
  const lines = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }).filter((e) => !skip(e.name)).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      if (lines.length >= max) return;
      lines.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && depth < 1) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return lines.join('\n');
}

export function gatherFacts(dir, { note = null, exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, windowsHide: true }) } = {}) {
  const last = note ? `Last brief (from my notes):\n${String(note).trim().slice(-1500)}` : '';
  if (!dir || !fs.existsSync(dir)) return ['New project, nothing built yet.', last].filter(Boolean).join('\n\n');
  const parts = [];
  const readme = ['README.md', 'readme.md', 'README.txt'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (readme) parts.push(`README:\n${fs.readFileSync(readme, 'utf8').trim().slice(0, 1500)}`);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})].slice(0, 30);
    parts.push([`package.json: ${pkg.name || '?'}${pkg.description ? ` — ${pkg.description}` : ''}`,
      Object.keys(pkg.scripts || {}).length ? `Scripts: ${Object.keys(pkg.scripts).join(', ')}` : '',
      deps.length ? `Uses: ${deps.join(', ')}` : ''].filter(Boolean).join('\n'));
  } catch { /* no package.json */ }
  const files = fileList(dir);
  if (files) parts.push(`Files:\n${files}`);
  try {
    const log = String(exec('git', ['-C', dir, 'log', '-5', '--format=%s']) || '').trim();
    if (log) parts.push(`Last changes:\n${log}`);
  } catch { /* not a git folder */ }
  if (last) parts.push(last);
  return parts.join('\n\n') || 'An empty folder.';
}
