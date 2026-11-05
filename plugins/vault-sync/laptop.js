import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeTitle } from '../wiki/vault.js';

// A project on the laptop as one note: where it is, what's in it, what changed lately. No file contents.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.env', 'graphify-out', '.next', 'coverage']);

const gitLog = (dir) => new Promise((resolve) => {
  execFile('git', ['log', '-5', '--format=%s'], { cwd: dir, windowsHide: true, timeout: 10_000 }, (err, out) => {
    resolve(err ? [] : String(out).split('\n').map((l) => l.trim()).filter(Boolean));
  });
});

export async function projectNote(project, { log = gitLog } = {}) {
  let entries;
  try { entries = await fs.promises.readdir(project.path, { withFileTypes: true }); } catch { return null; }
  const shown = entries.filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.env')).slice(0, 25).map((e) => `- ${e.name}${e.isDirectory() ? '/' : ''}`);
  const name = safeTitle(project.name) || 'Project';
  const recent = await log(project.path);
  const text = ['---', 'type: laptop-project', '---', '', `# ${name}`, '', `Folder: ${project.path}`, '',
    '## In the folder', '', ...shown, '',
    ...(recent.length ? ['## Latest changes', '', ...recent.map((l) => `- ${l}`), ''] : [])].join('\n');
  return { rel: `${name}.md`, text };
}
