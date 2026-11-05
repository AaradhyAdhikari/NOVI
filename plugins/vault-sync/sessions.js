import fs from 'node:fs';
import path from 'node:path';
import { askedText } from '../claude-link/activity.js';
import { looksSecret, safeTitle } from '../wiki/vault.js';

// A Claude session as a short note, without AI: what was asked, what got done, which files changed.
const CHUNK = 300_000; // the start holds the ask, the end the result: a session can be many MB
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const baseOf = (p) => path.basename(String(p || '').replace(/\\/g, '/'));
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cleanLines = (s) => String(s || '').split('\n').filter((l) => !looksSecret(l)).join('\n');

async function ends(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (at, length) => {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, at);
      return buf.toString('utf8');
    };
    if (size <= CHUNK * 2) return read(0, size);
    return `${await read(0, CHUNK)}\n${await read(size - CHUNK, CHUNK)}`;
  } finally {
    await fh.close();
  }
}

const parse = (text) => text.split('\n').flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

const textOf = (row) => {
  const c = row?.message?.content;
  return oneLine(Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : c);
};

export async function readSession(file) {
  const rows = parse(await ends(file));
  const first = rows.find((r) => r?.type === 'user' && askedText(r));
  if (!first) return null;
  const cwd = rows.find((r) => r?.cwd)?.cwd || '';
  const stamp = rows.find((r) => r?.timestamp)?.timestamp;
  const date = stamp ? String(stamp).slice(0, 10) : (await fs.promises.stat(file)).mtime.toISOString().slice(0, 10);
  const last = [...rows].reverse().find((r) => r?.type === 'assistant' && textOf(r));
  const files = [...new Set(rows.flatMap((r) => [].concat(r?.message?.content || [])
    .filter((c) => c?.type === 'tool_use' && WRITES.has(c.name)).map((c) => baseOf(c.input?.file_path || c.input?.notebook_path))))].filter(Boolean);
  return {
    id: path.basename(file, '.jsonl').slice(0, 8),
    project: baseOf(cwd) || 'Other',
    date,
    asked: cleanLines(askedText(first)).trim(),
    done: last ? oneLine(cleanLines(textOf(last))).slice(0, 400) : '',
    files: files.slice(0, 12),
  };
}

export function sessionNote(s) {
  const project = safeTitle(s.project) || 'Other';
  const short = safeTitle(oneLine(s.asked).split(' ').slice(0, 7).join(' ')).slice(0, 50).trim() || 'session';
  const lines = [
    '---', 'type: claude-session', `project: ${project}`, `date: ${s.date}`, '---', '',
    `# ${short}`, '', `Project: [[${project}]]`, `Date: ${s.date}`, '',
    '## Asked', '', oneLine(s.asked).slice(0, 600), '',
    ...(s.done ? ['## Done', '', s.done, ''] : []),
    ...(s.files.length ? ['## Files', '', ...s.files.map((f) => `- ${f}`), ''] : []),
  ];
  return { rel: path.join(project, `${s.date} ${short} ${s.id}.md`), text: lines.join('\n') };
}
