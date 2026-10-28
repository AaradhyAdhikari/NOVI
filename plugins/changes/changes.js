// What Claude changed in a project, without AI: git (changed lines since the last commit, plus new
// files) or, for a project without git, the files the last coding task wrote.
import path from 'node:path';

export function parseNumstat(text) {
  return String(text || '').split('\n').filter((l) => l.trim()).map((line) => {
    const [a, r, ...rest] = line.split('\t');
    const binary = a === '-' || r === '-';
    return { file: rest.join('\t').trim(), added: binary ? null : Number(a), removed: binary ? null : Number(r) };
  }).filter((c) => c.file);
}

// [{ file, added, removed, isNew? }] since the last commit; null when the folder isn't a git repo.
export async function gitChanges(dir, { exec }) {
  try { await exec(['rev-parse', '--is-inside-work-tree']); } catch { return null; }
  const changed = parseNumstat(await exec(['diff', '--numstat', 'HEAD']).catch(() => ''));
  const status = await exec(['status', '--porcelain']).catch(() => '');
  const fresh = String(status).split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
  return [...changed, ...fresh.filter((f) => !changed.some((c) => c.file === f)).map((file) => ({ file, added: null, removed: null, isNew: true }))];
}

const base = (f) => path.posix.basename(String(f).replace(/\\/g, '/').replace(/\/$/, ''));
const label = (c) => `${base(c.file)} (${c.isNew ? 'new' : c.added == null ? 'changed' : `+${c.added} −${c.removed}`})`;

export function changeSummary(list) {
  if (!list.length) return 'Nothing has changed since the last commit.';
  const shown = list.slice(0, 4).map(label);
  const more = list.length - shown.length;
  const joined = more ? `${shown.join(', ')} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  return `Claude changed ${list.length} file${list.length === 1 ? '' : 's'}: ${joined}.`;
}

export const changeLine = (c) => `- ${c.file} (${c.isNew ? 'new' : c.added == null ? 'changed' : `+${c.added} −${c.removed}`})`;

// The files a coding task wrote (absolute paths) that are inside this project, as project paths.
export function fromTaskFiles(files, root) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/$/, '');
  const r = norm(root).toLowerCase();
  return (files || []).map(norm).filter((f) => f.toLowerCase().startsWith(`${r}/`))
    .map((f) => ({ file: f.slice(r.length + 1), added: null, removed: null }));
}
