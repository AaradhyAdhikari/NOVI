import fs from 'node:fs';
import path from 'node:path';

// A one-way copy of a vault's notes. It reads `from` and only ever writes inside `to`, so editing the copy
// changes nothing and the next run puts it back.
const SKIP = new Set(['.obsidian', '.trash', '.git']);

async function notesIn(root, leaveOut = []) {
  const out = new Map();
  const walk = async (dir, depth) => {
    if (depth > 8) return;
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !(depth === 0 && leaveOut.includes(e.name))) await walk(full, depth + 1); } else if (e.isFile() && e.name.endsWith('.md')) out.set(path.relative(root, full), full);
    }
  };
  await walk(root, 0);
  return out;
}

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// leaveOut: top-level folders that aren't copied, so two copies can't feed each other.
export async function mirror(from, to, { leaveOut = [] } = {}) {
  if (inside(to, from) || inside(from, to)) throw new Error('The copy and the original must be separate folders.');
  const notes = await notesIn(from, leaveOut); // a missing folder throws here, before anything is touched
  if (!notes.size) return { copied: 0, removed: 0 }; // an empty original is more likely a mistake than a wish
  let copied = 0;
  for (const [rel, source] of notes) {
    const target = path.join(to, rel);
    const [a, b] = await Promise.all([fs.promises.readFile(source), fs.promises.readFile(target).catch(() => null)]);
    if (b && a.equals(b)) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, a);
    copied += 1;
  }
  let removed = 0;
  if (fs.existsSync(to)) {
    for (const [rel, full] of await notesIn(to)) {
      if (!notes.has(rel)) { await fs.promises.rm(full, { force: true }); removed += 1; }
    }
  }
  return { copied, removed };
}
