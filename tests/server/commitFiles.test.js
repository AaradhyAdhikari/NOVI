import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { PluginHost } from '../../server/plugins/host.js';
import { createCommitPlugin } from '../../plugins/commit/index.js';

// User, 2026-11-12: "everything … committed and pushed to my GitHub, every commit under me … automated and
// done by all but pushed under my name". Your yes on a team task's card commits exactly that task's files
// under your git name and pushes them; agents never commit themselves.
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

function repo() {
  const remote = tmp('novi-remote-');
  git(remote, 'init', '-q', '--bare');
  const dir = tmp('novi-work-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'The User');
  git(dir, 'config', 'user.email', 'user@example.com');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  return { dir, remote };
}

function setup() {
  const tasks = new EventEmitter();
  const rt = { tasks, say() {}, notice() {}, logger: { warn() {}, info() {} } };
  const host = new PluginHost({ runtime: rt, env: {}, logger: { warn() {}, info() {} } });
  host.register(createCommitPlugin({ run: async () => ({ code: 0 }) }));
  return rt;
}

describe('commit and push one task\'s files under your name', () => {
  it('commits only those files, as you, and pushes', async () => {
    const { dir, remote } = repo();
    const rt = setup();
    fs.writeFileSync(path.join(dir, 'a.js'), 'a2 agent\n');
    fs.writeFileSync(path.join(dir, 'mine.js'), 'my own unfinished work\n');
    const out = await rt.commitFiles({ path: dir, name: 'P', files: ['a.js'], message: 'T-001: Change a' });
    expect(out).toMatchObject({ ok: true, pushed: true });
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'main').trim()).toBe('The User|T-001: Change a');
    expect(git(remote, 'show', '--name-only', '--format=', 'main').trim()).toBe('a.js');
    expect(git(dir, 'status', '--porcelain')).toMatch(/mine\.js/); // your other work stays uncommitted
  });

  it('a private file or a key is never committed', async () => {
    const { dir } = repo();
    const rt = setup();
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
    expect((await rt.commitFiles({ path: dir, name: 'P', files: ['.env'], message: 'm' })).ok).toBe(false);
    fs.writeFileSync(path.join(dir, 'a.js'), `const k = "${'sk-ant-'}api03-${'a'.repeat(40)}";\n`); // built here: this file itself holds no key-shaped text
    const out = await rt.commitFiles({ path: dir, name: 'P', files: ['a.js'], message: 'm' });
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/key/);
    expect(git(dir, 'log', '--format=%s').trim().split('\n')).toEqual(['start']);
  });

  it('no GitHub link: committed, not pushed, said so', async () => {
    const dir = tmp('novi-local-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'The User');
    git(dir, 'config', 'user.email', 'user@example.com');
    fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'start');
    fs.writeFileSync(path.join(dir, 'a.js'), 'b\n');
    const out = await setup().commitFiles({ path: dir, name: 'P', files: ['a.js'], message: 'T-1: b' });
    expect(out).toMatchObject({ ok: true, pushed: false });
    expect(out.note).toMatch(/no GitHub link/);
  });

  it('a team task\'s coder run gets no second commit card', async () => {
    const { dir } = repo();
    const rt = setup();
    const notices = [];
    rt.notice = (n) => notices.push(n);
    rt.teamRun = (id) => id === 'run-7';
    fs.writeFileSync(path.join(dir, 'a.js'), 'changed\n');
    let asked = 0;
    rt.ask = async () => { asked += 1; return { allow: false }; };
    rt.tasks.emit('task', { id: 'run-7', status: 'done', path: dir, project: 'P' });
    await new Promise((r) => setTimeout(r, 300));
    expect(asked).toBe(0);
    expect(notices).toHaveLength(0);
  });
});

describe('commit safety (security review)', () => {
  it('"[.]env" is a name, never a pattern that grabs your real .env', async () => {
    const { dir } = repo();
    const rt = setup();
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    const out = await rt.commitFiles({ path: dir, name: 'P', files: ['[.]env'], message: 'm' });
    expect(out.ok).not.toBe(true);
    expect(git(dir, 'log', '--format=%s').trim().split('\n')).toEqual(['start']);
  });
  it('push: false commits without pushing', async () => {
    const { dir, remote } = repo();
    const rt = setup();
    fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
    const out = await rt.commitFiles({ path: dir, name: 'P', files: ['a.js'], message: 'T-1: x', push: false });
    expect(out).toMatchObject({ ok: true, pushed: false });
    expect(git(remote, 'log', '--format=%s', 'main').trim()).toBe('start');
  });
});
