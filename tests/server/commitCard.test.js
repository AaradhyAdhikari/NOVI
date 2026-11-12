import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PluginHost } from '../../server/plugins/host.js';
import { createCommitPlugin } from '../../plugins/commit/index.js';
import { commitCommand } from '../../server/brain/commitCommand.js';
import { isPrivateFile, fileWithKey } from '../../plugins/commit/work.js';

vi.setConfig({ testTimeout: 60_000 }); // real git, slow when the whole suite runs at once

// One card with the changes and a suggested message; a yes commits under the user's name and pushes
// (user, 2026-11-04). These run real git on throwaway folders.
const dirs = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-commit-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may hold a temp folder a moment */ } } });
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text = 'hello\n') => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

function repo({ remote = true } = {}) {
  const dir = temp();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, 'README.md', '# app\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  let bare = null;
  if (remote) {
    bare = temp();
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  return { dir, bare };
}

function setup(dir, { decisions = [{ allow: true }], message = 'Add the login page', run, hold = false, home } = {}) {
  const asked = [];
  const said = [];
  const updates = [];
  const notices = [];
  const offered = [];
  let release = null;
  const tasks = new EventEmitter();
  const left = [...decisions];
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const runtime = {
    ask: async (card) => { asked.push(card); if (hold) return new Promise((resolve) => { release = resolve; }); return left.shift() || { allow: false }; },
    updateCard: (id, patch) => updates.push({ id, ...patch }),
    notice: (n) => notices.push(n),
    offerCodeEdit: (card) => { offered.push(card); return 'edit-1'; },
    say: (text) => { said.push(text); },
    privateComplete: async () => { if (message instanceof Error) throw message; return message; },
    codingProject: (name) => (name === 'nothing' || !dir ? null : { name: 'Shop', path: dir }),
    tasks,
  };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, info() {} } });
  expect(host.register(createCommitPlugin({ run: run || (async () => ({ code: 0, output: '' })), onDone: finished, ...(home ? { home } : {}) }))).toBe(true);
  const tool = (name, params = {}) => host.get(name).run(params);
  // The work after the card runs in the background.
  return { asked, said, tasks, tool, updates, offered, notices, settled: () => done, answer: (d) => release(d), view: (...a) => host.runtime.commitView(...a), edited: (...a) => host.runtime.commitEdited(...a), canEdit: (...a) => host.runtime.commitCanEdit(...a), commitOffer: (...a) => host.runtime.commitOffer(...a) };
}

describe('the commit card', () => {
  it('shows the files and the message; a yes commits and pushes', async () => {
    const { dir, bare } = repo();
    write(dir, 'login.html');
    write(dir, 'README.md', '# app!\n');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(s.asked[0].title).toBe('Commit and push 2 files in Shop?');
    expect(s.asked[0].prompt).toBe('Shop: commit 2 files and push?');
    expect(s.asked[0].detail).toContain('Add the login page');
    expect(s.asked[0].detail).toContain('login.html');
    expect(s.asked[0].grantable).not.toBe(true);
    expect(git(bare, 'log', '-1', '--format=%s|%an', 'main')).toBe('Add the login page|Test User');
    expect(s.said.at(-1)).toBe('Committed and pushed 2 files in Shop.');
  });

  it('no: nothing is committed', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir, { decisions: [{ allow: false }] });
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('first');
    expect(git(dir, 'status', '--porcelain')).toBe('?? a.js');
  });

  it('"change the message to X" shows a new card with those words', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir, { decisions: [{ allow: false, change: 'the message to Fix the cart' }, { allow: true }] });
    await s.tool('code_commit');
    await s.settled();
    expect(s.asked[1].detail).toContain('Fix the cart');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Fix the cart');
  });

  it('with no AI the message names the files', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir, { message: new Error('busy') });
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Update a.js');
  });

  it('nothing new: says so, no card', async () => {
    const { dir } = repo();
    const s = setup(dir);
    expect((await s.tool('code_commit')).note).toBe('Nothing new to commit in Shop.');
    expect(s.asked).toEqual([]);
  });

  it('says plainly when it has no project or no git', async () => {
    expect((await setup(null).tool('code_commit')).note).toBe('Which project?');
    expect((await setup(temp()).tool('code_commit')).note).toBe('Shop has no git.');
  });

  it('commits already made are pushed from the same card', async () => {
    const { dir, bare } = repo();
    write(dir, 'a.js');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'made by hand');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(s.asked[0].prompt).toBe('Shop: push 1 commit?');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('made by hand');
  });

  it('only one card per project at a time', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir);
    const first = s.tool('code_commit');
    const second = await s.tool('code_commit');
    await first;
    await s.settled();
    expect(second.note).toBe('A commit card for Shop is already waiting.');
    expect(s.asked.length).toBe(1);
  });
});

describe('what never goes to GitHub', () => {
  it('private files stay out, even with no .gitignore', async () => {
    const { dir, bare } = repo();
    write(dir, 'a.js');
    write(dir, '.env', 'KEY=1\n');
    write(dir, 'config/.env.local', 'KEY=1\n');
    write(dir, 'NOVI CONTEXT.txt');
    write(dir, 'certs/server.pem');
    write(dir, 'id_rsa');
    write(dir, '.env.example', 'KEY=\n');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(s.asked[0].title).toBe('Commit and push 2 files in Shop?');
    expect(s.asked[0].detail).toMatch(/Left out: .*\.env/);
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort()).toEqual(['.env.example', 'README.md', 'a.js']);
  });

  it('a key inside a file stops everything and says which file', async () => {
    const { dir } = repo();
    write(dir, 'config.js', `const key = 'gsk_${'a'.repeat(30)}';\n`);
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('first');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(s.said.at(-1)).toBe('I stopped: config.js looks like it holds a key. Nothing was committed.');
  });

  it('files that changed after the card was shown are not committed unseen', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir);
    const ask = s.asked;
    ask.push = function push(card) { write(dir, 'sneaked.js'); return Array.prototype.push.call(this, card); };
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('first');
    expect(s.said.at(-1)).toBe('The files in Shop changed after the card. Nothing was committed. Say commit my work again.');
  });
});

describe('a yes covers only what the card showed', () => {
  // A card whose yes comes after `change` has run.
  const later = (dir, change) => {
    const s = setup(dir);
    const push = s.asked.push.bind(s.asked);
    s.asked.push = (card) => { change(); return push(card); };
    return s;
  };

  it('a file edited after the card is not committed', async () => {
    const { dir } = repo();
    write(dir, 'a.js', 'one\n');
    const s = later(dir, () => write(dir, 'a.js', 'two\n'));
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('first');
    expect(s.said.at(-1)).toMatch(/changed after the card/);
  });

  it('another branch after the card: nothing happens', async () => {
    const { dir, bare } = repo();
    write(dir, 'a.js');
    const s = later(dir, () => git(dir, 'checkout', '-q', '-b', 'other'));
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('first');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('first');
    expect(s.said.at(-1)).toMatch(/changed after the card/);
  });

  it('a commit made after the card: nothing happens', async () => {
    const { dir, bare } = repo();
    write(dir, 'a.js');
    const s = later(dir, () => { write(dir, 'b.js'); git(dir, 'add', 'b.js'); git(dir, 'commit', '-q', '-m', 'sneaked'); });
    await s.tool('code_commit');
    await s.settled();
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('first');
    expect(s.said.at(-1)).toMatch(/changed after the card/);
  });
});

describe('commits already waiting to go out are checked too', () => {
  it('a private file in one: nothing is pushed', async () => {
    const { dir, bare } = repo();
    write(dir, '.env', 'KEY=1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'oops');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('first');
    expect(s.said.at(-1)).toBe('I stopped: .env is in a commit waiting to go out. Nothing was pushed.');
  });

  it('a key in one: nothing is pushed', async () => {
    const { dir, bare } = repo();
    write(dir, 'b.js', `const k = 'ghp_${'b'.repeat(30)}';\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'oops');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('first');
    expect(s.said.at(-1)).toBe('I stopped: b.js looks like it holds a key. Nothing was pushed.');
  });
});

describe('more private things', () => {
  it('knows them by path and by what they hold', () => {
    for (const f of ['data/brain.json', '.aws/credentials', 'home/.ssh/config', '.npmrc', '.netrc']) expect(isPrivateFile(f), f).toBe(true);
    for (const f of ['src/data/cities.json', 'src/app.js', '.env.example']) expect(isPrivateFile(f), f).toBe(false);
    for (const line of [`csk-${'a'.repeat(30)}`, `tvly-${'a'.repeat(30)}`, `hf_${'a'.repeat(30)}`, `jina_${'a'.repeat(30)}`, `GROQ_API_KEY=${'a'.repeat(24)}`]) {
      expect(fileWithKey(`+++ b/x\n+${line}\n`), line).toBe('x');
    }
    expect(fileWithKey('+++ b/x\n+const API_KEY = process.env.API_KEY;\n')).toBe(null);
  });
});

describe('when GitHub says no', () => {
  it('no remote: commits and says it could not push', async () => {
    const { dir } = repo({ remote: false });
    write(dir, 'a.js');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add the login page');
    expect(s.said.at(-1)).toBe('Committed 1 file in Shop. It has no GitHub link, so nothing was pushed.');
  });

  it('work on GitHub is merged in first', async () => {
    const { dir, bare } = repo();
    const other = temp();
    git(other, 'clone', '-q', bare, '.');
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'o@example.com');
    write(other, 'theirs.js');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    write(dir, 'mine.js');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort()).toEqual(['README.md', 'mine.js', 'theirs.js']);
  });

  it('a clash: the merge is undone, nothing is pushed, the commit stays', async () => {
    const { dir, bare } = repo();
    const other = temp();
    git(other, 'clone', '-q', bare, '.');
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'o@example.com');
    write(other, 'README.md', '# theirs\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    write(dir, 'README.md', '# mine\n');
    const s = setup(dir);
    await s.tool('code_commit');
    await s.settled();
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add the login page');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe('theirs');
    expect(s.said.at(-1)).toBe('Committed in Shop, but GitHub has changes that clash with it, so nothing was pushed. Ask Claude to merge them.');
  });
});

describe('pull', () => {
  it('gets the latest and says so', async () => {
    const { dir, bare } = repo();
    const other = temp();
    git(other, 'clone', '-q', bare, '.');
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'o@example.com');
    write(other, 'theirs.js');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const s = setup(dir);
    expect((await s.tool('code_pull')).note).toBe('Got the latest for Shop.');
    expect(fs.existsSync(path.join(dir, 'theirs.js'))).toBe(true);
    expect((await s.tool('code_pull')).note).toBe('Shop is already up to date.');
  });
});

describe('when Claude finishes a task', () => {
  const finish = (s, dir) => s.tasks.emit('task', { id: 't1', status: 'done', project: 'Shop', path: dir });

  it('tests pass: the card comes by itself, once', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    write(dir, 'package.json', '{"scripts":{"test":"vitest"}}');
    const s = setup(dir);
    finish(s, dir);
    finish(s, dir);
    await s.settled();
    expect(s.asked.length).toBe(1);
    expect(s.asked[0].detail).toContain('Tests passed');
  });

  it('tests fail: no card, and it says why', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    write(dir, 'package.json', '{"scripts":{"test":"vitest"}}');
    const s = setup(dir, { run: async () => ({ code: 1, output: '' }) });
    finish(s, dir);
    for (let i = 0; i < 100 && !s.said.length; i++) await new Promise((r) => { setTimeout(r, 100); });
    expect(s.asked).toEqual([]);
    expect(s.said).toEqual(["Shop's tests failed, so I'm not offering a commit."]);
  });

  it('a task that did not finish offers nothing', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir);
    s.tasks.emit('task', { id: 't2', status: 'running', project: 'Shop', path: dir });
    await new Promise((r) => { setTimeout(r, 100); });
    expect(s.asked).toEqual([]);
  });
});

describe('the words', () => {
  it('takes the everyday ways of saying it', () => {
    for (const said of ['commit my work', 'Commit and push my changes.', 'okay, commit the code', 'push my code', 'push to github', 'save my work to GitHub', 'commit karo', 'code push karo', 'github pe push kar do']) {
      expect(commitCommand(said), said).toEqual({ tool: 'code_commit', args: {} });
    }
    expect(commitCommand('commit my work on Portfolio')).toEqual({ tool: 'code_commit', args: { project: 'Portfolio' } });
    expect(commitCommand('push the tip calculator project')).toEqual({ tool: 'code_commit', args: { project: 'tip calculator' } });
    for (const said of ['pull my code', 'pull from github', 'get the latest from GitHub', 'git pull']) {
      expect(commitCommand(said), said).toEqual({ tool: 'code_pull', args: {} });
    }
  });
  it('leaves other words alone', () => {
    for (const said of ['what did I commit yesterday', 'commit this to memory', 'push the button', 'pull up the weather', 'push notifications are off']) {
      expect(commitCommand(said), said).toBe(null);
    }
  });
});

// User, 2026-11-04: see the changes from the card, then the code, then fix a line from the phone.
describe('looking at the changes from the card', () => {
  const waiting = async (dir) => {
    const s = setup(dir, { hold: true });
    await s.tool('code_commit');
    return { s, id: s.asked[0].changes.id };
  };
  const edited = () => {
    const { dir } = repo();
    write(dir, 'app.js', 'one\ntwo\nthree\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'app');
    git(dir, 'push', '-q', 'origin', 'main');
    write(dir, 'app.js', 'one\nTWO\nthree\nfour\n');
    return dir;
  };

  it('the card lists each file with its added and removed lines', async () => {
    const dir = edited();
    write(dir, 'new.js', 'a\nb\n');
    const { s } = await waiting(dir);
    expect(s.asked[0].changes.message).toBe('Add the login page');
    expect(s.asked[0].changes.files).toEqual([{ file: 'app.js', added: 2, removed: 1 }, { file: 'new.js', isNew: true }]);
  });

  it('a file shows its changed lines with a little around them', async () => {
    const { s, id } = await waiting(edited());
    const v = await s.view(id, 'app.js');
    expect(v.lines.filter((l) => l.type === 'del').map((l) => l.text)).toEqual(['two']);
    expect(v.lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['TWO', 'four']);
    expect(v.lines.some((l) => l.type === 'ctx' && l.text === 'one')).toBe(true);
  });

  it('a new file is all added', async () => {
    const { dir } = repo();
    write(dir, 'new.js', 'a\nb\n');
    const { s, id } = await waiting(dir);
    expect((await s.view(id, 'new.js')).lines).toEqual([{ type: 'add', text: 'a' }, { type: 'add', text: 'b' }]);
  });

  it('very long changes stop at 300 lines and say so', async () => {
    const { dir } = repo();
    write(dir, 'big.js', Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const { s, id } = await waiting(dir);
    const v = await s.view(id, 'big.js');
    expect(v.lines.length).toBe(300);
    expect(v.cut).toBe(true);
  });

  it('pictures just say so', async () => {
    const { dir } = repo();
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 0, 3]));
    const { s, id } = await waiting(dir);
    expect(await s.view(id, 'logo.png')).toEqual({ file: 'logo.png', binary: true });
    expect(await s.view(id, 'logo.png', { whole: true })).toEqual({ file: 'logo.png', binary: true });
  });

  it('the whole file marks what changed and can be edited', async () => {
    const dir = edited();
    const { s, id } = await waiting(dir);
    const v = await s.view(id, 'app.js', { whole: true });
    expect(v.text).toBe('one\nTWO\nthree\nfour\n');
    expect(v.changed).toEqual([2, 4]);
    expect(v.editId).toBe('edit-1');
    expect(s.offered[0]).toMatchObject({ root: dir, file: 'app.js', start: 1 });
  });

  it('only files on the card: private ones and anything else are refused', async () => {
    const dir = edited();
    write(dir, '.env', 'KEY=1\n');
    const { s, id } = await waiting(dir);
    for (const file of ['.env', 'README.md', '../secret.txt']) expect(await s.view(id, file), file).toEqual({ error: "That file isn't on the card." });
    expect(await s.view('nope', 'app.js')).toEqual({ error: "That file isn't on the card." });
    expect(s.asked[0].detail).not.toContain('KEY=1');
  });

  it('an edit made through the card refreshes it, and the yes then commits it', async () => {
    const dir = edited();
    const { s, id } = await waiting(dir);
    write(dir, 'app.js', 'one\nTWO\nthree\nfour\nfive\n');
    await s.edited(dir, 'app.js');
    expect(s.updates[0].id).toBe(id);
    expect(s.updates[0].changes.files).toEqual([{ file: 'app.js', added: 3, removed: 1 }]);
    s.answer({ allow: true });
    await s.settled();
    expect(fs.readFileSync(path.join(dir, 'app.js'), 'utf8')).toContain('five');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add the login page');
  });

  it('an edit does not bless another file that changed meanwhile', async () => {
    const dir = edited();
    write(dir, 'other.js', 'a\n');
    const { s } = await waiting(dir);
    write(dir, 'other.js', 'changed by someone else\n');
    write(dir, 'app.js', 'mine\n');
    await s.edited(dir, 'app.js');
    s.answer({ allow: true });
    await s.settled();
    expect(s.said.at(-1)).toMatch(/changed after the card/);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('app');
  });

  it('an edit that puts a file back takes it off the card', async () => {
    const dir = edited();
    write(dir, 'other.js', 'a\n');
    const { s } = await waiting(dir);
    write(dir, 'app.js', 'one\ntwo\nthree\n');
    await s.edited(dir, 'app.js');
    expect(s.updates[0].changes.files).toEqual([{ file: 'other.js', isNew: true }]);
    expect(s.updates[0].title).toBe('Commit and push 1 file in Shop?');
    s.answer({ allow: true });
    await s.settled();
    expect(git(dir, 'log', '-1', '--name-only', '--format=')).toBe('other.js');
  });

  it('putting the only file back leaves nothing to send', async () => {
    const dir = edited();
    const { s } = await waiting(dir);
    write(dir, 'app.js', 'one\ntwo\nthree\n');
    await s.edited(dir, 'app.js');
    s.answer({ allow: true });
    await s.settled();
    expect(s.said.at(-1)).toBe('Nothing new to commit in Shop.');
  });

  it('an edit is only taken while the card waits', async () => {
    const dir = edited();
    const { s, id } = await waiting(dir);
    expect(s.canEdit(id, 'app.js')).toBe(true);
    expect(s.canEdit(id, 'README.md')).toBe(false);
    expect(s.canEdit('nope', 'app.js')).toBe(false);
    s.answer({ allow: true });
    await s.settled();
    expect(s.canEdit(id, 'app.js')).toBe(false);
  });

  it('a file off the card is not refreshed', async () => {
    const dir = edited();
    const { s } = await waiting(dir);
    await s.edited(dir, 'README.md');
    expect(s.updates).toEqual([]);
  });
});

// User, 2026-11-05: "dont ask ... just send it for every session every convo".
describe('the card comes by itself when Claude finishes work', () => {
  const offer = (s, dir) => s.commitOffer(dir);

  it('offers the project of that folder, even from a folder inside it', async () => {
    const { dir } = repo();
    write(dir, 'src/a.js');
    const s = setup(dir);
    await offer(s, path.join(dir, 'src'));
    await s.settled();
    expect(s.asked[0].title).toBe(`Commit and push 1 file in ${path.basename(dir)}?`);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Add the login page');
  });
  it('a folder with no git, or nothing new, stays quiet', async () => {
    const s = setup(temp());
    await offer(s, temp());
    const { dir } = repo();
    await offer(s, dir);
    expect(s.asked).toEqual([]);
    expect(s.said).toEqual([]);
  });
  it('no: the same changes are not offered again; new changes are', async () => {
    const { dir } = repo();
    write(dir, 'a.js', 'one\n');
    const s = setup(dir, { decisions: [{ allow: false }, { allow: false }] });
    await offer(s, dir);
    await new Promise((r) => { setTimeout(r, 100); });
    await offer(s, dir);
    await new Promise((r) => { setTimeout(r, 100); });
    expect(s.asked.length).toBe(1);
    write(dir, 'a.js', 'two\n');
    await offer(s, dir);
    await new Promise((r) => { setTimeout(r, 100); });
    expect(s.asked.length).toBe(2);
  });
  it('one card at a time: a waiting card is left alone', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir, { hold: true });
    await offer(s, dir);
    await offer(s, dir);
    expect(s.asked.length).toBe(1);
  });
});

// User, 2026-11-05: one card, not two, and tests first where a project has them.
describe('the card after work', () => {
  const tested = (dir) => { write(dir, 'package.json', '{"scripts":{"test":"vitest"}}'); write(dir, 'a.js'); };
  const small = () => { const calls = []; return { calls, fallback: (line) => calls.push(line ?? null) }; };

  it('tests pass: the commit card comes, and no small card', async () => {
    const { dir } = repo();
    tested(dir);
    const s = setup(dir);
    const f = small();
    await s.commitOffer(dir, f);
    await s.settled();
    expect(s.asked[0].detail).toContain('Tests passed');
    expect(f.calls).toEqual([]);
  });
  it('tests fail: no commit card; the small card says why', async () => {
    const { dir } = repo();
    tested(dir);
    const s = setup(dir, { run: async () => ({ code: 1, output: '' }) });
    const f = small();
    await s.commitOffer(dir, f);
    expect(s.asked).toEqual([]);
    expect(f.calls).toEqual(['The tests failed, so there is no commit card yet.']);
  });
  it('no tests in the project: the commit card comes and says so', async () => {
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir);
    await s.commitOffer(dir, small());
    await s.settled();
    expect(s.asked[0].detail).toContain('No tests to run here');
  });
  it('nothing to commit, no git, or a card already waiting: just the small card', async () => {
    const f = small();
    const clean = repo().dir;
    await setup(clean).commitOffer(clean, f);
    const plain = temp();
    await setup(plain).commitOffer(plain, f);
    const { dir } = repo();
    write(dir, 'a.js');
    const s = setup(dir, { hold: true });
    await s.commitOffer(dir, small());
    await s.commitOffer(dir, f);
    expect(f.calls).toEqual([null, null, null]);
    expect(s.asked.length).toBe(1);
  });
  it('tests already running for that project are not started twice', async () => {
    const { dir } = repo();
    tested(dir);
    let runs = 0;
    let finish;
    const s = setup(dir, { run: () => { runs += 1; return new Promise((r) => { finish = r; }); } });
    const first = s.commitOffer(dir, small());
    while (!finish) await new Promise((r) => { setTimeout(r, 20); }); // the tests have started
    const f = small();
    await s.commitOffer(dir, f);
    finish({ code: 0, output: '' });
    await first;
    await s.settled();
    expect(runs).toBe(1);
    expect(f.calls).toEqual([null]);
  });
  it("a task Novi started with nothing to commit still gets the small card", async () => {
    const { dir } = repo();
    const s = setup(dir);
    s.tasks.emit('task', { id: 't9', status: 'done', project: 'Shop', path: dir });
    // Real git answers slowly when the whole suite runs at once (a fixed 0.4 s wait failed): wait for the card.
    await vi.waitFor(() => expect(s.notices).toEqual([{ key: 'claude', title: 'Claude finished in Shop' }]), { timeout: 10_000, interval: 100 });
  });
});

describe('folders it stays out of', () => {
  it('a git repo in the home folder: no tests, no card', async () => {
    const { dir } = repo();
    write(dir, 'package.json', '{"scripts":{"test":"vitest"}}');
    let ran = 0;
    const s = setup(dir, { home: dir, run: async () => { ran += 1; return { code: 0, output: '' }; } });
    const calls = [];
    await s.commitOffer(dir, { fallback: (l) => calls.push(l ?? null) });
    expect(ran).toBe(0);
    expect(s.asked).toEqual([]);
    expect(calls).toEqual([null]);
  });
  it('a small card that fails never brings Novi down', async () => {
    const { dir } = repo();
    const s = setup(dir);
    await expect(s.commitOffer(dir, { fallback: () => { throw new Error('no'); } })).resolves.toBeUndefined();
  });
});
