// Stable facts about a project folder, gathered without any AI: the README's first paragraph as the goal,
// the tech from package.json / requirements.txt / pyproject.toml, the git branch and the last commits.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { techWordsFrom } from '../../server/voice/techWords.js';

const readSmall = (file) => { try { return fs.statSync(file).size <= 64 * 1024 ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; } };
export const projectId = (name) => String(name || 'project').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// The first plain paragraph after the title: no headings, badges, code or lists.
export function goalFrom(readme) {
  for (const block of String(readme || '').split(/\r?\n\s*\r?\n/)) {
    const t = block.trim();
    if (!t || /^(#|!\[|\[!\[|```|<|[-*|>]\s|\d+\.\s)/.test(t)) continue;
    return t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return '';
}

export function projectFacts(dir, { name, exec = (cmd, args) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 3000, windowsHide: true }) } = {}) {
  const files = Object.fromEntries(['package.json', 'requirements.txt', 'pyproject.toml', 'README.md'].map((f) => [f, readSmall(path.join(dir, f))]));
  const git = (args) => { try { return String(exec('git', ['-C', dir, ...args]) || '').trim(); } catch { return ''; } };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commits = git(['log', '-5', '--format=%h %s']).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // README words only describe; the stack is what the project's files say it uses.
  const stack = techWordsFrom({ ...files, 'README.md': '' }).slice(0, 15);
  const label = name || path.basename(dir);
  return { id: projectId(label), name: label, path: dir, goal: goalFrom(files['README.md']), tech_stack: stack, current_branch: branch || null, recent_commits: commits };
}
