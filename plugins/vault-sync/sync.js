import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession, sessionNote } from './sessions.js';
import { projectNote } from './laptop.js';
import { mirror } from './mirror.js';

const MAX_AGE_MS = 60 * 24 * 3600_000;
const BACKGROUND = /claude-mem|observer-sessions/i;

async function write(file, text) {
  const old = await fs.promises.readFile(file, 'utf8').catch(() => null);
  if (old === text) return false;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text);
  return true;
}

async function sessionFiles(dir, now) {
  const out = [];
  for (const folder of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!folder.isDirectory() || BACKGROUND.test(folder.name)) continue;
    for (const name of await fs.promises.readdir(path.join(dir, folder.name)).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, folder.name, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat && now() - stat.mtimeMs < MAX_AGE_MS) out.push({ file, mtime: stat.mtimeMs });
    }
  }
  return out;
}

// One pass: sessions and projects into Claude Brain (its Sessions and Laptop folders), then a copy each way. `state` remembers which sessions were read.
export async function syncOnce({
  sessions = path.join(os.homedir(), '.claude', 'projects'), brain, novi, projects = [], state = {}, read = readSession, now = Date.now, perRun = 40,
}) {
  state.seen ||= {};
  let notes = 0;
  const waiting = (await sessionFiles(sessions, now)).filter((s) => state.seen[s.file] !== s.mtime).slice(0, perRun);
  for (const { file, mtime } of waiting) {
    const s = await read(file).catch(() => null);
    state.seen[file] = mtime;
    if (s && !BACKGROUND.test(s.project)) {
      const note = sessionNote(s);
      if (await write(path.join(brain, 'Sessions', note.rel), note.text)) notes += 1;
    }
  }
  for (const project of projects) {
    const note = await projectNote(project).catch(() => null);
    if (note && await write(path.join(brain, 'Laptop', note.rel), note.text)) notes += 1;
  }
  // Both brains hold everything (user, 2026-11-05): Novi's notes into Claude Brain, Claude Brain into Novi
  // Brain. Each leaves out the other's copy, or they would keep copying each other.
  await fs.promises.mkdir(novi, { recursive: true });
  const back = await mirror(novi, path.join(brain, 'Novi'), { leaveOut: ['Claude Brain'] });
  const copy = await mirror(brain, path.join(novi, 'Claude Brain'), { leaveOut: ['Novi'] });
  return { notes, copied: back.copied + copy.copied, removed: back.removed + copy.removed };
}
