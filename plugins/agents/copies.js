// Phase 5 (2026-11-12): several coders at once without stepping on each other.
// Each task gets its own copy of the project (a git worktree outside the project folder) that starts from
// what is really on disk: the last commit plus your uncommitted work, with the libraries (node_modules…)
// linked in, never your secrets. Your yes brings back only the files that task changed, and only when
// nobody changed them in your folder since (all or nothing); else the clash is named and nothing moves.
// No commits are made here: committing is the user's (done by Novi under their name after the yes).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { gitArgs, testEnv } from './review.js';
import { isPrivateFile } from '../commit/work.js';

// Folders of downloaded libraries: linked into the copy (tests need them), never copied or brought back.
const LIBS = ['node_modules', '.venv', 'venv'];
const OURS = /^(?:\.novi|\.git)(?:\/|$)/i;
// Windows doesn't care about capitals: "Node_Modules/x.js" or ".Novi/tasks.json" are the same folders (security review).
const skip = (f) => { const low = String(f).toLowerCase(); return OURS.test(low) || isPrivateFile(f) || isPrivateFile(low) || LIBS.some((l) => low === l || low.startsWith(`${l}/`)); };
// Changes to these come back but are never pushed by themselves: they decide what runs (CI, hooks, installs).
export const RISKY = /(?:^|\/)(?:\.github\/|\.husky\/|\.githooks\/|package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|\.gitattributes$|\.gitmodules$|\.npmrc$|requirements[^/]*\.txt$|pyproject\.toml$|setup\.py$|Makefile$)/i;
const DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const MAX_FILE = 20 * 1024 * 1024;

const defaultGit = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', gitArgs(args), { cwd, windowsHide: true, env: testEnv(), maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
});

// A real file under root, reached without going through any link (an agent's symlink to a secret elsewhere
// is never read or copied: security review). null for anything else.
const plainFile = (root, rel) => {
  const parts = rel.split('/');
  let at = root;
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]);
    let st;
    try { st = fs.lstatSync(at); } catch { return null; }
    if (st.isSymbolicLink()) return null;
    if (i === parts.length - 1) return st.isFile() && st.size <= MAX_FILE ? at : null;
  }
  return null;
};
const hashOf = (root, rel) => {
  const file = plainFile(root, rel);
  if (!file) return null;
  try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};
// Every link inside a folder is unlinked (never followed) before the folder is deleted.
function unlinkAll(root) {
  const walk = (dir) => {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* left */ } } } else if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
}
const slug = (s) => String(s).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const safeRel = (f) => {
  const n = path.posix.normalize(String(f).replace(/\\/g, '/'));
  if (n.startsWith('../') || n === '..' || path.isAbsolute(n) || /^[a-z]:/i.test(n)) return null;
  // No alternate data streams ("a:b"), trailing dots/spaces, short "~1" names or device names (security review).
  if (n.split('/').some((p) => !p || p.includes(':') || /[. ]$/.test(p) || /~\d/.test(p) || DEVICE.test(p))) return null;
  return n;
};

export function createCopies({ root, git = defaultGit } = {}) {
  const placeOf = (dir, taskId) => {
    const tag = crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 8);
    return path.join(root, `${slug(path.basename(dir))}-${tag}`, slug(taskId));
  };
  const metaOf = (place) => `${place}.json`;

  // Every file git would see in a folder (tracked + new, minus ignored), with its content hash.
  async function hashes(folder) {
    const out = {};
    const list = (await git(['ls-files', '-co', '--exclude-standard', '-z'], folder)).split('\0').filter(Boolean);
    for (const raw of new Set(list)) {
      const f = safeRel(raw);
      if (!f || skip(f)) continue;
      const h = hashOf(folder, f);
      if (h) out[f] = h;
    }
    return out;
  }

  const save = (work) => {
    fs.mkdirSync(path.dirname(metaOf(work.meta)), { recursive: true });
    fs.writeFileSync(metaOf(work.meta), JSON.stringify(work));
    return work;
  };

  const unlinkLibs = async (place) => unlinkAll(place);

  const api = {
    // Can tasks get their own copy here (git with at least one commit)?
    async canCopy(dir) { try { await git(['rev-parse', '--verify', 'HEAD'], dir); return true; } catch { return false; } },

    // A new copy for one task, or null when the folder has no git (or no commit yet).
    // links: put your libraries (node_modules…) in as links. Only for an agent whose own rules stop it
    // writing there (OpenCode): a write through the link would land in your real libraries (security review).
    async open({ dir, taskId, links = false }) {
      try { await git(['rev-parse', '--verify', 'HEAD'], dir); } catch { return null; }
      const place = placeOf(dir, taskId);
      const old = api.find({ dir, taskId });
      if (old) await api.close(old);
      else if (fs.existsSync(place)) { unlinkAll(place); fs.rmSync(place, { recursive: true, force: true }); await git(['worktree', 'prune'], dir).catch(() => {}); }
      fs.mkdirSync(path.dirname(place), { recursive: true });
      await git(['worktree', 'add', '--detach', '-q', place, 'HEAD'], dir);
      // Your uncommitted work: changed and new files copied in, deleted ones removed (secrets never).
      const rows = (await git(['status', '--porcelain', '-z', '-uall', '--no-renames'], dir)).split('\0').filter(Boolean);
      for (const row of rows) {
        const f = safeRel(row.slice(3));
        if (!f || skip(f)) continue;
        const from = path.join(dir, f);
        const to = path.join(place, f);
        if (fs.existsSync(from) && fs.statSync(from).isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); } else fs.rmSync(to, { force: true });
      }
      for (const l of links ? LIBS : []) {
        const from = path.join(dir, l);
        const to = path.join(place, l);
        try { if (fs.statSync(from).isDirectory() && !fs.existsSync(to)) fs.symlinkSync(from, to, 'junction'); } catch { /* none */ }
      }
      // mine = your folder at this moment: a later change there is a clash (line endings may differ from the copy).
      return save({ copy: true, path: place, dir, taskId, meta: place, base: await hashes(place), mine: await hashes(dir) });
    },

    // Working in your own folder (Claude and Novi Coder take one task at a time there): only what changes
    // after this point counts as the task's.
    async snapshot({ dir, taskId }) {
      let base = {};
      try { base = await hashes(dir); } catch { /* no git: nothing to tell apart */ }
      return save({ copy: false, path: dir, dir, taskId, meta: placeOf(dir, taskId), base });
    },

    // The copy or snapshot a task had before Novi restarted.
    find({ dir, taskId }) {
      try { return JSON.parse(fs.readFileSync(metaOf(placeOf(dir, taskId)), 'utf8')); } catch { return null; }
    },

    // [{ file, how: added|changed|deleted }]
    async changes(work) {
      const now = await hashes(work.path);
      const out = [];
      for (const f of new Set([...Object.keys(work.base), ...Object.keys(now)])) {
        if (skip(f)) continue;
        const was = work.base[f];
        const is = now[f];
        if (was === is) continue;
        out.push({ file: f, how: !was ? 'added' : !is ? 'deleted' : 'changed', hash: is || null });
      }
      return out.sort((a, b) => a.file.localeCompare(b.file));
    },

    // { ok, files } or { ok: false, clash: [files], files: [] } or { ok: false, changed: true } when the work
    // differs from what the card showed (seen = { file: hash|null } from that moment).
    async bringBack(work, { seen = null } = {}) {
      const list = await api.changes(work);
      if (seen) {
        const same = list.length === Object.keys(seen).length && list.every((c) => Object.hasOwn(seen, c.file) && seen[c.file] === c.hash);
        if (!same) return { ok: false, changed: true, clash: [], files: [] };
      }
      const files = list.map((c) => c.file);
      if (!work.copy) return { ok: true, files };
      const clash = [];
      const todo = [];
      for (const c of list) {
        const f = safeRel(c.file);
        if (!f) continue;
        const mine = hashOf(work.dir, f);
        if (mine === c.hash) continue; // already the same in your folder
        if (mine !== ((work.mine || work.base)[c.file] || null)) clash.push(c.file); else todo.push({ ...c, file: f });
      }
      if (clash.length) return { ok: false, clash, files: [] };
      for (const c of todo) {
        const to = path.join(work.dir, c.file);
        if (c.how === 'deleted') fs.rmSync(to, { force: true });
        else {
          const from = plainFile(work.path, c.file);
          if (!from) continue;
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        }
      }
      return { ok: true, files };
    },

    async close(work) {
      if (!work) return;
      if (work.copy) {
        await unlinkLibs(work.path); // first: removing the copy must never reach into your libraries
        await git(['worktree', 'remove', '--force', work.path], work.dir).catch(async () => {
          fs.rmSync(work.path, { recursive: true, force: true });
          await git(['worktree', 'prune'], work.dir).catch(() => {});
        });
      }
      fs.rmSync(metaOf(work.meta), { force: true });
    },
  };
  return api;
}

// File names a step mentions ("index.html", "src/app.js"): two steps naming the same file never run at once.
export function filesNamed(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:^|[\s"'`(])((?:[\w-]+\/)*[\w-]+\.[a-z][a-z0-9]{0,5})(?=$|[\s"'`),;:!?]|\.(?:\s|$))/gi)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function createLocks() {
  const held = new Map(); // task → Set of lowercase files
  return {
    claim(task, files) { held.set(task, new Set([...(held.get(task) || []), ...files.map((f) => String(f).toLowerCase())])); },
    release(task) { held.delete(task); },
    heldBy(files, except = null) {
      for (const [task, set] of held) {
        if (task === except) continue;
        if (files.some((f) => set.has(String(f).toLowerCase()))) return task;
      }
      return null;
    },
    tasks: () => [...held.keys()],
  };
}
