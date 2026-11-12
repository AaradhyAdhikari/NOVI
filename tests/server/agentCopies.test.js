import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCopies, filesNamed, createLocks } from '../../plugins/agents/copies.js';

// Phase 5 (2026-11-12): several coders at once, each in its own copy of the project (git worktree), so two
// agents never write into the same folder; your yes brings back only the files that task changed, and only
// when nobody changed them since (else nothing comes back and it is redone on top of the current files).
const tmp = (p = 'novi-copies-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });

function project() {
  const dir = tmp('novi-proj-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a1\n');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b1\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  fs.mkdirSync(path.join(dir, 'node_modules', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'lib', 'index.js'), 'lib\n');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=secret\n');
  // Your own work not committed yet: the copy must start from it, not from the last commit.
  fs.writeFileSync(path.join(dir, 'b.js'), 'b2 mine\n');
  fs.writeFileSync(path.join(dir, 'new.js'), 'new mine\n');
  return dir;
}

describe('a copy of the project for one task', () => {
  it('holds the committed files, your uncommitted work and the libraries, never your secrets', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-001', links: true });
    expect(copy.path).not.toBe(dir);
    expect(fs.readFileSync(path.join(copy.path, 'a.js'), 'utf8')).toBe('a1\n');
    expect(fs.readFileSync(path.join(copy.path, 'b.js'), 'utf8')).toBe('b2 mine\n');
    expect(fs.readFileSync(path.join(copy.path, 'new.js'), 'utf8')).toBe('new mine\n');
    expect(fs.existsSync(path.join(copy.path, 'node_modules', 'lib', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(copy.path, '.env'))).toBe(false);
    await copies.close(copy);
  });

  it('what the task changed: edited, added and deleted files, never Novi\'s record', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-002' });
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2 agent\n');
    fs.writeFileSync(path.join(copy.path, 'c.js'), 'c agent\n');
    fs.rmSync(path.join(copy.path, 'new.js'));
    fs.mkdirSync(path.join(copy.path, '.novi'), { recursive: true });
    fs.writeFileSync(path.join(copy.path, '.novi', 'x.md'), 'record');
    const ch = await copies.changes(copy);
    expect(ch.map((c) => `${c.file}:${c.how}`).sort()).toEqual(['a.js:changed', 'c.js:added', 'new.js:deleted']);
    await copies.close(copy);
  });

  it('your yes brings exactly those files back into your folder', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-003' });
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2 agent\n');
    fs.writeFileSync(path.join(copy.path, 'c.js'), 'c agent\n');
    fs.rmSync(path.join(copy.path, 'new.js'));
    const out = await copies.bringBack(copy);
    expect(out).toMatchObject({ ok: true });
    expect(out.files.sort()).toEqual(['a.js', 'c.js', 'new.js']);
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf8')).toBe('a2 agent\n');
    expect(fs.readFileSync(path.join(dir, 'c.js'), 'utf8')).toBe('c agent\n');
    expect(fs.existsSync(path.join(dir, 'new.js'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'b.js'), 'utf8')).toBe('b2 mine\n'); // untouched by the task
    await copies.close(copy);
  });

  it('a file someone changed in your folder since: nothing comes back, the clash is named', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-004' });
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2 agent\n');
    fs.writeFileSync(path.join(copy.path, 'c.js'), 'c agent\n');
    fs.writeFileSync(path.join(dir, 'a.js'), 'a3 someone else\n');
    const out = await copies.bringBack(copy);
    expect(out).toMatchObject({ ok: false, clash: ['a.js'] });
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf8')).toBe('a3 someone else\n');
    expect(fs.existsSync(path.join(dir, 'c.js'))).toBe(false); // all or nothing
    await copies.close(copy);
  });

  it('a secret the agent wrote in the copy never comes back', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-005' });
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2\n');
    fs.writeFileSync(path.join(copy.path, 'server.key'), 'xx');
    const out = await copies.bringBack(copy);
    expect(out.files).toEqual(['a.js']);
    expect(fs.existsSync(path.join(dir, 'server.key'))).toBe(false);
    await copies.close(copy);
  });

  it('closing removes the copy and leaves your libraries alone', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-006', links: true });
    await copies.close(copy);
    expect(fs.existsSync(copy.path)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'node_modules', 'lib', 'index.js'), 'utf8')).toBe('lib\n');
    expect(git(dir, 'worktree', 'list')).not.toMatch(/T-006/);
  });

  it('a copy left from before (Novi restarted) is found again by its folder', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'T-007' });
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2\n');
    const again = copies.find({ dir, taskId: 'T-007' });
    expect(again.path).toBe(copy.path);
    expect((await copies.bringBack(again)).files).toEqual(['a.js']);
    await copies.close(again);
  });

  it('working in your own folder (one coder at a time): only what changed since the start counts', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const here = await copies.snapshot({ dir, taskId: 'T-008' });
    fs.writeFileSync(path.join(dir, 'a.js'), 'a2 claude\n');
    expect((await copies.changes(here)).map((c) => c.file)).toEqual(['a.js']); // b.js/new.js were yours before
    expect(await copies.bringBack(here)).toMatchObject({ ok: true, files: ['a.js'] });
  });

  it('a folder without git: no copy', async () => {
    const copies = createCopies({ root: tmp() });
    expect(await copies.open({ dir: tmp('novi-nogit-'), taskId: 'T-1' })).toBe(null);
  });
});

describe('an untrusted agent in the copy (security review)', () => {
  it('libraries are linked in only when asked (an agent whose rules stop it writing there)', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'S-1' });
    expect(fs.existsSync(path.join(copy.path, 'node_modules'))).toBe(false);
    await copies.close(copy);
  });
  it('"Node_Modules" and ".Novi" in other capitals never come back', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'S-2' });
    fs.mkdirSync(path.join(copy.path, 'Node_Modules2'), { recursive: true });
    fs.mkdirSync(path.join(copy.path, '.NOVI'), { recursive: true });
    fs.writeFileSync(path.join(copy.path, '.NOVI', 'tasks.json'), '{}');
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2\n');
    expect((await copies.changes(copy)).map((c) => c.file)).toEqual(['a.js']);
    await copies.close(copy);
  });
  it('a link the agent made to a file elsewhere is never read or copied', async () => {
    const dir = project();
    const outside = tmp('novi-secret-');
    fs.writeFileSync(path.join(outside, 'notes.txt'), 'private notes');
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'S-3' });
    let linked = true;
    try { fs.symlinkSync(outside, path.join(copy.path, 'docs'), 'junction'); } catch { linked = false; }
    if (linked) {
      const out = await copies.bringBack(copy);
      expect(out.files.some((f) => f.startsWith('docs'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'docs'))).toBe(false);
    }
    await copies.close(copy);
    expect(fs.readFileSync(path.join(outside, 'notes.txt'), 'utf8')).toBe('private notes'); // closing never reaches through it
  });
  it('the yes covers only what the card showed', async () => {
    const dir = project();
    const copies = createCopies({ root: tmp() });
    const copy = await copies.open({ dir, taskId: 'S-4' });
    fs.writeFileSync(path.join(copy.path, 'a.js'), 'a2\n');
    const seen = Object.fromEntries((await copies.changes(copy)).map((c) => [c.file, c.hash]));
    fs.writeFileSync(path.join(copy.path, 'sneaky.js'), 'later\n');
    expect(await copies.bringBack(copy, { seen })).toMatchObject({ ok: false, changed: true });
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf8')).toBe('a1\n');
    await copies.close(copy);
  });
});

describe('file locks', () => {
  it('file names in a step', () => {
    expect(filesNamed('Fix the header in index.html and src/app.js')).toEqual(['index.html', 'src/app.js']);
    expect(filesNamed('Make the page nicer')).toEqual([]);
  });
  it('two tasks naming the same file never run at once; a finished one holds its files until your answer', () => {
    const locks = createLocks();
    locks.claim('T-1', ['index.html']);
    expect(locks.heldBy(['INDEX.html', 'b.js'])).toBe('T-1');
    expect(locks.heldBy(['b.js'])).toBe(null);
    expect(locks.heldBy(['index.html'], 'T-1')).toBe(null); // its own lock
    locks.release('T-1');
    expect(locks.heldBy(['index.html'])).toBe(null);
  });
});
