import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// What a project says about itself: recent commits, its notes file, the open items of its newest
// plan, TODOs in the code, and Novi's last coding tasks there. Read-only, no shell; anything
// missing (no git, no notes) is just empty.
const exec = promisify(execFile);
const NOTES = ['CLAUDE.md', 'AGENTS.md', 'README.md'];

async function git(dir, args) {
  try {
    return (await exec('git', args, { cwd: dir, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
  } catch {
    return '';
  }
}

function newestPlan(dir) {
  const plans = path.join(dir, 'docs', 'superpowers', 'plans');
  try {
    const files = fs.readdirSync(plans).filter((f) => f.endsWith('.md')).sort();
    return files.length ? fs.readFileSync(path.join(plans, files.at(-1)), 'utf8') : '';
  } catch {
    return '';
  }
}

export async function gatherSources({ dir, tasks = [] }) {
  const isRepo = (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  const commits = isRepo ? (await git(dir, ['log', '--since=14.days', '--pretty=%s', '-n', '15'])).split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const head = isRepo ? (await git(dir, ['rev-parse', 'HEAD'])).trim() || null : null;
  const notesFile = NOTES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').slice(0, 4096) : '';
  const openItems = [...newestPlan(dir).matchAll(/^\s*-\s\[ \]\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 20);
  const todos = isRepo ? (await git(dir, ['grep', '-n', '-I', '-E', 'TODO|FIXME', '--', '.', ':!node_modules'])).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20) : [];
  const lastTasks = tasks.slice(0, 3).map((t) => `${t.instruction || t.title || 'task'} (${t.status || 'unknown'})`);
  return { commits, head, notes, openItems, todos, lastTasks };
}
