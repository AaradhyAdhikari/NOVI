// One record per project (multi-agent orchestrator, Phase 1, 2026-11-11; spec: "NOVI owns the project.
// Agents own tasks. The project state owns the truth."). Everything lives in <project>/.novi/:
//   project.json     stable facts (goal, tech, branch), created_at kept across updates
//   tasks.json       the task board: id, title, owner, status (TASK_STATES), history, summary, note
//   context.md       a short readable overview, rewritten by Novi from the three files above
//   decisions.md     decisions every agent must respect (appended, never rewritten)
//   audit-log.jsonl  one line per change: task moves, decisions
// Writes are atomic (temp file + rename) and never leave the .novi folder. A broken JSON file is kept
// aside as "<name>.broken-<time>" and a fresh one started, so nothing is silently lost.
import fs from 'node:fs';
import path from 'node:path';
import { looksSecret } from '../wiki/vault.js';

export const TASK_STATES = ['planned', 'assigned', 'waiting_approval', 'review', 'changes_requested', 'approved', 'merged', 'failed', 'blocked', 'cancelled'];
const OPEN = new Set(['planned', 'assigned', 'waiting_approval', 'review', 'changes_requested', 'approved', 'blocked']);
const MAX_TASKS = 500;
const FIELDS = ['title', 'role', 'owner', 'summary', 'note', 'agent_run', 'depends_on', 'acceptance_criteria', 'source', 'output', 'feedback', 'level'];
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function openProjectState(dir, { now = Date.now } = {}) {
  const root = path.join(path.resolve(dir), '.novi');
  const file = (name) => path.join(root, name);
  const iso = () => new Date(now()).toISOString();

  // A project folder that is gone (renamed or deleted) is never made again as an empty ghost.
  const folderThere = () => {
    if (!fs.existsSync(path.dirname(root))) throw new Error(`The project folder ${path.dirname(root)} is gone, so I didn't write its record.`);
  };
  // Novi's own record files stay out of git (code review: they hold your raw instructions, and every task
  // would otherwise put them on the commit card). run.json and checks.json are not touched.
  const OWN = ['project.json', 'tasks.json', 'context.md', 'decisions.md', 'audit-log.jsonl', '*.broken-*', '*.tmp'];
  const ignoreOwn = () => {
    if (fs.existsSync(file('.gitignore'))) return;
    fs.writeFileSync(file('.gitignore'), ["# Novi's project record (plugins/project-state): kept on this laptop, not in git.", ...OWN, ''].join('\n'));
  };
  const write = (name, text) => {
    folderThere();
    fs.mkdirSync(root, { recursive: true });
    ignoreOwn();
    const tmp = `${file(name)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file(name));
  };
  const readJson = (name, fallback) => {
    let text;
    try { text = fs.readFileSync(file(name), 'utf8'); } catch { return fallback; }
    try { return JSON.parse(text); } catch {
      try { fs.renameSync(file(name), `${file(name)}.broken-${now()}`); } catch { /* best effort */ }
      return fallback;
    }
  };
  const audit = (entry) => {
    folderThere();
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(file('audit-log.jsonl'), `${JSON.stringify({ at: iso(), ...entry })}\n`);
  };
  const noSecrets = (...texts) => {
    if (texts.some((t) => looksSecret(t))) throw new Error('That looks like a secret (a key, password or token), so I left it out of the project record.');
  };

  const project = () => readJson('project.json', null);
  const tasks = () => {
    const t = readJson('tasks.json', { tasks: [] });
    return Array.isArray(t?.tasks) ? t.tasks : [];
  };

  function decisions() {
    let text = '';
    try { text = fs.readFileSync(file('decisions.md'), 'utf8'); } catch { return []; }
    const out = [];
    for (const block of text.split(/\n(?=## )/)) {
      const head = /^## (\d{4}-\d{2}-\d{2}) — (.+)$/m.exec(block);
      if (!head) continue;
      const field = (k) => (new RegExp(`^${k}: (.*)$`, 'm').exec(block) || [])[1] || '';
      out.push({ date: head[1], title: head[2].trim(), decision: field('Decision'), reason: field('Reason'), owner: field('Owner'), status: field('Status') });
    }
    return out;
  }

  function writeContext() {
    const p = project() || {};
    const list = tasks();
    const open = list.filter((t) => OPEN.has(t.status));
    const done = list.filter((t) => t.status === 'merged' || t.status === 'review' || t.status === 'approved').slice(0, 15);
    const dec = decisions().slice(-10);
    const lines = [
      `# ${p.name || path.basename(path.dirname(root))}`,
      '',
      '_Written by Novi from project.json, tasks.json and decisions.md. Add decisions there, not here._',
      '',
      `Goal: ${p.goal || '(not written yet)'}`,
      p.tech_stack?.length ? `Tech stack: ${p.tech_stack.join(', ')}` : '',
      p.current_branch ? `Branch: ${p.current_branch}` : '',
      `Updated: ${p.updated_at || iso()}`,
      '',
      '## Active tasks',
      ...(open.length ? open.map((t) => `- [${t.status}] ${t.title} (${t.owner || 'unassigned'}, ${t.id})${t.note ? ` — ${t.note}` : ''}`) : ['- none']),
      '',
      '## Completed work',
      ...(done.length ? done.map((t) => `- ${t.title} (${t.owner || '?'})${t.summary ? `: ${clip(t.summary, 160)}` : ''}`) : ['- none yet']),
      '',
      '## Decisions',
      ...(dec.length ? dec.map((d) => `- ${d.date} ${d.title}: ${d.decision}`) : ['- none yet']),
      p.recent_commits?.length ? `\n## Recent commits\n${p.recent_commits.map((c) => `- ${c}`).join('\n')}` : '',
      '',
    ];
    write('context.md', lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
  }

  return {
    dir: root,
    project,
    tasks,
    decisions,
    // Facts gathered without AI (facts.js). created_at survives every later update.
    ensure(facts = {}) {
      const old = project() || {};
      const next = { status: 'active', ...old, ...facts, created_at: old.created_at || iso(), updated_at: iso() };
      write('project.json', `${JSON.stringify(next, null, 2)}\n`);
      if (!fs.existsSync(file('decisions.md'))) write('decisions.md', '# Decisions\n\nDecisions every agent working on this project must respect.\n');
      writeContext();
      return next;
    },
    // redact: for text Novi didn't write itself (the coder's instruction and summary) — a secret-looking
    // field is left out and the move still happens, instead of the task freezing on the board.
    upsertTask(input = {}, { redact = false } = {}) {
      const change = { ...input };
      if (!change.id) throw new Error('A task needs an id.');
      if (change.status && !TASK_STATES.includes(change.status)) throw new Error(`"${change.status}" is not a task state. States: ${TASK_STATES.join(', ')}.`);
      if (redact) { for (const k of ['title', 'summary', 'note', 'feedback']) if (looksSecret(change[k])) change[k] = '(left out: it looked private)'; }
      noSecrets(change.title, change.summary, change.note);
      const list = tasks();
      const i = list.findIndex((t) => t.id === change.id);
      const old = i >= 0 ? list[i] : { id: change.id, title: '', owner: null, status: 'planned', created_at: iso(), history: [] };
      const next = { ...old };
      for (const k of FIELDS) if (change[k] !== undefined) next[k] = typeof change[k] === 'string' ? clip(change[k], 500) : Array.isArray(change[k]) ? change[k].map((x) => clip(x, 300)).slice(0, 20) : change[k];
      const moved = change.status && change.status !== old.status;
      if (change.status) next.status = change.status;
      // Nothing new (the coder repeats the same state many times): no writes at all.
      if (i >= 0 && !moved && FIELDS.every((k) => JSON.stringify(next[k]) === JSON.stringify(old[k]))) return old;
      if (moved || i < 0) next.history = [...(old.history || []), { status: next.status, at: iso() }].slice(-40);
      next.updated_at = iso();
      if (i >= 0) list[i] = next; else list.unshift(next);
      write('tasks.json', `${JSON.stringify({ tasks: list.slice(0, MAX_TASKS) }, null, 2)}\n`);
      if (moved || i < 0) audit({ action: 'task', task: next.id, owner: next.owner, from: i >= 0 ? old.status : null, to: next.status, title: next.title });
      writeContext();
      return next;
    },
    addDecision({ title, decision, reason = '', owner = 'User', status = 'Accepted' } = {}) {
      if (!clip(title, 1) || !clip(decision, 1)) throw new Error('A decision needs a title and what was decided.');
      noSecrets(title, decision, reason);
      if (!fs.existsSync(file('decisions.md'))) write('decisions.md', '# Decisions\n\nDecisions every agent working on this project must respect.\n');
      const d = { date: iso().slice(0, 10), title: clip(title, 80), decision: clip(decision, 400), reason: clip(reason, 400), owner: clip(owner, 40), status: clip(status, 20) };
      fs.appendFileSync(file('decisions.md'), `\n## ${d.date} — ${d.title}\nDecision: ${d.decision}\nReason: ${d.reason}\nOwner: ${d.owner}\nStatus: ${d.status}\n`);
      audit({ action: 'decision', title: d.title, owner: d.owner });
      writeContext();
      return d;
    },
  };
}

// Novi's coding task (server/claude/taskManager.js status()) as a board task.
const CODER_STATE = { running: 'assigned', done: 'review', failed: 'failed', stopped: 'cancelled' };
export function taskFromCoder(t) {
  if (!t || t.active === false || !t.id || !CODER_STATE[t.status]) return null;
  const owner = /novi coder/i.test(t.agent || '') ? 'novi-coder' : /claude/i.test(t.agent || 'claude') ? 'claude' : clip(t.agent, 30).toLowerCase();
  return { id: t.id, title: clip(t.instruction, 120) || 'Coding task', owner, status: CODER_STATE[t.status], ...(t.summary ? { summary: t.summary } : {}) };
}
