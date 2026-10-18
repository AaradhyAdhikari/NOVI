import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskManager, permissionTitle, claudeAsk } from '../../server/claude/taskManager.js';
import { ClaudeSession } from '../../server/claude/session.js';
import { Memory } from '../../server/memory.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { UserFacingError } from '../../server/errors.js';

const fake = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));

let memory;
let approvals;
let asked;
let spawned;

function makeManager({ answer = true } = {}) {
  approvals = new ApprovalQueue();
  asked = [];
  approvals.on('added', (a) => { asked.push(a); approvals.resolve(a.id, answer); });
  spawned = [];
  const tm = new TaskManager({
    memory,
    approvals,
    narratorIntervalMs: 10,
    createSession: (opts) => {
      spawned.push(opts.resumeSessionId || null);
      return new ClaudeSession({ command: process.execPath, argsPrefix: [fake], ...opts });
    },
  });
  const spoken = [];
  const fed = [];
  tm.on('speak', (t) => spoken.push(t));
  tm.on('feed', (f) => fed.push(f.text));
  return { tm, spoken, fed };
}

const until = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => (fn() ? resolve() : Date.now() - started > ms ? reject(new Error('timeout')) : setTimeout(tick, 10));
  tick();
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tm-'));
  memory = new Memory(path.join(dir, 'memory.json'));
  memory.rememberProject('portfolio', fs.mkdtempSync(path.join(dir, 'portfolio ')));
});

describe('TaskManager', () => {
  it('rejects unknown projects with a user-facing error', () => {
    const { tm } = makeManager();
    expect(() => tm.start('nope', 'x')).toThrow(UserFacingError);
  });

  it('runs a task end to end with approval, narration and persistence', async () => {
    const { tm, spoken, fed } = makeManager();
    tm.start('portfolio', 'add login');
    expect(tm.status()).toMatchObject({ active: true, project: 'portfolio', status: 'running' });
    await until(() => tm.status().status === 'done');
    expect(asked).toHaveLength(0); // edits inside the project no longer ask (2026-10-18)
    expect(fed).toContain('Reading app.js');
    expect(spoken.at(-1)).toBe('Claude finished. Finished: add login.');
    expect(memory.lastTask()).toMatchObject({ project: 'portfolio', status: 'done', sessionId: 'fake-session-1' });
    await tm.shutdown();
  });

  it('skips approval for edits when allowEdits is on', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'add login');
    tm.setAllowEdits(true);
    await until(() => tm.status().status === 'done');
    expect(asked).toHaveLength(0);
    await tm.shutdown();
  });

  it('refuses a second task while one is running', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'HANG');
    expect(() => tm.start('portfolio', 'other')).toThrow(/already working/);
    await tm.shutdown();
  });

  it('resumes the last session after a restart', async () => {
    const first = makeManager();
    first.tm.start('portfolio', 'add login');
    await until(() => first.tm.status().status === 'done');
    await first.tm.shutdown();

    const second = makeManager();
    second.tm.send('now add tests');
    await until(() => second.tm.status().status === 'done');
    expect(spawned).toEqual(['fake-session-1']);
    await second.tm.shutdown();
  });

  it('stop() marks the task stopped without an "exited unexpectedly" message', async () => {
    const { tm, spoken } = makeManager();
    tm.start('portfolio', 'HANG');
    await new Promise((r) => setTimeout(r, 200));
    expect(await tm.stop()).toBe(true);
    expect(tm.status().status).toBe('stopped');
    expect(spoken.join(' ')).not.toMatch(/unexpectedly/);
    expect(await tm.stop()).toBe(false);
  });

  it('shutdown() leaves no live session', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'HANG');
    await tm.shutdown();
    expect(tm.session.exited).toBe(true);
  });

  it('send() with no task at all is a user-facing error', () => {
    const fresh = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tm2-')), 'm.json'));
    const tm = new TaskManager({ memory: fresh, approvals: new ApprovalQueue(), createSession: () => { throw new Error('no'); } });
    expect(() => tm.send('x')).toThrow(UserFacingError);
  });
});

describe('permissionTitle', () => {
  it('describes commands and edits', () => {
    expect(permissionTitle('Bash', { command: 'npm i' })).toBe('Claude wants to run: npm i');
    expect(permissionTitle('Edit', { file_path: 'a.js' })).toBe('Claude wants to edit a.js');
    expect(permissionTitle('WebFetch', {})).toBe('Claude wants to use WebFetch');
  });

  // Live (2026-10-17): the card and the voice read out a 20-line headless-browser command.
  it('long commands: what it is for (Claude\'s description), never the command itself', () => {
    const command = 'B="/c/Program Files/Google/Chrome/Application/chrome.exe"\n"$B" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=3000 --window-size=1280,1400 --screenshot="$TEMP/pf-projects2.png" http://localhost:8765/projects.html 2>/dev/null';
    const ask = claudeAsk('Bash', { command }, 'Re-capture screenshots after animations settle.');
    expect(ask.title).toBe('Claude wants to run a command: Re-capture screenshots after animations settle');
    expect(ask.prompt).toBe('Claude wants to re-capture screenshots after animations settle.');
    expect(ask.detail).toBe(command); // the command stays on the card, folded away
    const bare = claudeAsk('Bash', { command });
    expect(bare.title).toBe('Claude wants to run a command');
    expect(bare.prompt).toBe('Claude wants to run a command.');
    expect(claudeAsk('Bash', { command: 'npm i' })).toMatchObject({ title: 'Claude wants to run: npm i', prompt: 'Claude wants to run npm i.' });
  });

  it('file edits name the file, not the whole path', () => {
    const ask = claudeAsk('Edit', { file_path: 'C:\\Users\\Aaradhy\\OneDrive\\Projects\\portfolio\\src\\index.html' }, '', 'Claude');
    expect(ask.title).toBe('Claude wants to edit index.html');
    expect(ask.prompt).toBe('Claude wants to edit index.html.');
    expect(ask.detail).toMatch(/portfolio/);
  });
});

describe('TaskManager.takeOver ("I\'m back, I\'ll take over")', () => {
  it('stops the background run and hands over the project and Claude conversation', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'HANG');
    await until(() => tm.task?.sessionId);
    const handed = await tm.takeOver();
    expect(handed).toMatchObject({ project: 'portfolio', sessionId: 'fake-session-1' });
    expect(handed.path).toBe(memory.findProject('portfolio').path);
    expect(tm.status().status).toBe('stopped');
  });

  it('also works after the task has finished, and after a restart', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'add login');
    await until(() => tm.status().status === 'done');
    expect((await tm.takeOver()).sessionId).toBe('fake-session-1');
    await tm.shutdown();
    const fresh = makeManager().tm;
    expect((await fresh.takeOver()).sessionId).toBe('fake-session-1');
  });

  it('says so when there is nothing to take over', async () => {
    const { tm } = makeManager();
    await expect(tm.takeOver()).rejects.toThrow(UserFacingError);
  });

  it('only Claude Code conversations can be continued in Claude Code', async () => {
    const { tm } = makeManager();
    tm.start('portfolio', 'add login', { agent: 'novi-coder' });
    tm.task.agentName = 'Novi Coder';
    await until(() => tm.status().status === 'done');
    await expect(tm.takeOver()).rejects.toThrow(/Novi Coder/);
  });
});

describe('the coder\'s plan ("what\'s the progress" / "what\'s next")', async () => {
  const { EventEmitter } = await import('node:events');
  const planManager = () => {
    const sent = [];
    let session;
    const tm = new TaskManager({
      memory,
      approvals: new ApprovalQueue(),
      narratorIntervalMs: 10,
      createSession: () => {
        session = Object.assign(new EventEmitter(), { exited: false, send: (t) => sent.push(t), stop: async () => {}, close: () => {} });
        return session;
      },
    });
    return { tm, sent, emit: (e) => session.emit('event', e) };
  };

  it('keeps the latest plan and edited files in the status', async () => {
    const { tm, sent, emit } = planManager();
    tm.start('portfolio', 'add login');
    expect(sent[0]).toBe('add login');
    emit({ kind: 'tool_use', name: 'TodoWrite', input: { todos: [
      { content: 'Create the login page', activeForm: 'Creating the login page', status: 'completed' },
      { content: 'Add form validation', activeForm: 'Adding form validation', status: 'in_progress' },
      { content: 'Write tests', activeForm: 'Writing tests', status: 'pending' },
    ] } });
    emit({ kind: 'tool_use', name: 'Write', input: { file_path: path.join(tm.task.path, 'src', 'login.html') } });
    expect(tm.status().plan).toEqual([
      { step: 'Create the login page', doing: 'Creating the login page', status: 'completed' },
      { step: 'Add form validation', doing: 'Adding form validation', status: 'in_progress' },
      { step: 'Write tests', doing: 'Writing tests', status: 'pending' },
    ]);
    expect(tm.status().files).toEqual([path.join(tm.task.path, 'src', 'login.html')]);
    await tm.shutdown();
  });
});

// User's decision (2026-10-17): Claude's ordinary terminal commands run without asking, in every
// project; risky ones still ask, and so do edits outside the project and Claude's own questions.
describe('coder commands without asking', () => {
  const task = { path: '/tmp/portfolio', agentName: 'Claude' };
  it('ordinary commands run at once (a feed line says so); risky ones still ask', async () => {
    const { tm } = makeManager();
    const auto = [];
    approvals.on('auto_allowed', (a) => auto.push(a.title));
    expect(await tm._onPermission(task, { toolName: 'Bash', input: { command: 'npm install' }, description: 'Install dependencies' })).toEqual({ allow: true });
    expect(await tm._onPermission(task, { toolName: 'PowerShell', input: { command: 'Get-ChildItem' } })).toEqual({ allow: true });
    expect(asked).toHaveLength(0);
    expect(auto).toEqual(['Claude wants to run a command: Install dependencies', 'Claude wants to run: Get-ChildItem']);
    for (const command of ['git push origin main', 'rm -rf build', 'reg delete HKCU\\Software\\X /f', 'npm install -g serve', 'sudo apt install x']) {
      await tm._onPermission(task, { toolName: 'Bash', input: { command } });
    }
    expect(asked.map((a) => a.tier)).toEqual(['high', 'high', 'high', 'high', 'high']);
  });

  // User, 2026-10-18: "it's asking too many questions" — one yes for the plan, then edits inside the
  // project run at once too; outside the project still asks.
  it('file edits inside the project run at once; outside it they still ask', async () => {
    const { tm } = makeManager();
    const auto = [];
    approvals.on('auto_allowed', (a) => auto.push(a.title));
    expect(await tm._onPermission(task, { toolName: 'Write', input: { file_path: '/tmp/portfolio/index.html' } })).toEqual({ allow: true });
    expect(asked).toHaveLength(0);
    expect(auto).toEqual(['Claude wants to write index.html']);
    await tm._onPermission(task, { toolName: 'Write', input: { file_path: '/etc/hosts' } });
    expect(asked).toHaveLength(1);
  });
});

// User, 2026-10-18: "the process in short should come first to me to verify … then Novi should work on it."
// Claude starts in plan mode; its plan comes as a card + a short spoken version; yes = it builds.
describe('plan first', async () => {
  const { EventEmitter } = await import('node:events');
  const PLAN = '# Blog for portfolio\n\n1. Add a blog page\n2. Add two sample posts\n3. Link it from the menu\n4. Check it on a phone';
  function planSetup(answer) {
    const q = new ApprovalQueue();
    const cards = [];
    const opened = [];
    q.on('added', (a) => { cards.push(a); answer(q, a); });
    const sent = [];
    const tm = new TaskManager({
      memory, approvals: q,
      createSession: (o) => { opened.push(o); return Object.assign(new EventEmitter(), { exited: false, send: (t) => sent.push(t), stop: async () => {}, close: () => {} }); },
    });
    return { tm, cards, opened, sent };
  }

  it('Claude plans first; the plan is a card with a short spoken line; yes lets it build without more questions', async () => {
    const { tm, cards, opened } = planSetup((q, a) => q.resolve(a.id, true));
    tm.start('portfolio', 'add a blog', { agent: 'claude' });
    expect(opened[0].permissionMode).toBe('plan');
    expect(await tm._onPermission(tm.task, { toolName: 'ExitPlanMode', input: { plan: PLAN } })).toEqual({ allow: true });
    expect(cards[0]).toMatchObject({ title: "Claude's plan for portfolio", source: 'claude', changeable: true, addable: true, tier: 'medium' });
    expect(cards[0].prompt).toBe("Claude's plan for portfolio: add a blog page, then add two sample posts, and 2 more steps. Go ahead?");
    expect(cards[0].detail).toBe(PLAN);
    expect(tm.task.allowEdits).toBe(true);
  });

  it('"change X" sends X back so Claude plans again; no stops it; "yes, also X" adds X', async () => {
    const changed = planSetup((q, a) => q.resolve(a.id, false, 'voice', null, { change: 'use a dark theme' }));
    changed.tm.start('portfolio', 'add a blog');
    expect(await changed.tm._onPermission(changed.tm.task, { toolName: 'ExitPlanMode', input: { plan: PLAN } })).toEqual({ allow: false, message: 'The user wants changes to the plan: use a dark theme. Make a new plan with that and show it again with ExitPlanMode.' });
    const no = planSetup((q, a) => q.resolve(a.id, false));
    no.tm.start('portfolio', 'add a blog');
    expect((await no.tm._onPermission(no.tm.task, { toolName: 'ExitPlanMode', input: { plan: PLAN } })).allow).toBe(false);
    const also = planSetup((q, a) => q.resolve(a.id, true, 'voice', null, { addition: 'add an RSS feed' }));
    also.tm.start('portfolio', 'add a blog');
    expect(await also.tm._onPermission(also.tm.task, { toolName: 'ExitPlanMode', input: { plan: PLAN } })).toEqual({ allow: true });
    expect(also.sent.at(-1)).toBe('Also: add an RSS feed');
  });

  it('a brief that was already approved, or Novi Coder, starts straight away', async () => {
    const { tm, opened } = planSetup(() => {});
    tm.start('portfolio', 'add a blog', { planFirst: false });
    tm.task.status = 'done';
    tm.start('portfolio', 'fix a typo', { agent: 'novi-coder' });
    expect(opened.map((o) => o.permissionMode)).toEqual([undefined, undefined]);
  });
});
