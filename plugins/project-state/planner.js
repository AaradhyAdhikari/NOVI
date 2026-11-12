// The planner (multi-agent orchestrator, Phase 2, 2026-11-11). The approved brief becomes tasks on the
// project's board: one per step, with an owner (the spec's roles: research → Perplexity, planning →
// ChatGPT, review → Gemini, building → Claude; the user's own choice wins), a dependency on the step before,
// and the brief's done-when list on the last step. The board is checked first, so a step already finished
// is reported and never planned again ("do not rebuild completed work"). taskPackage() is what an agent is
// given: only the context its task needs.
import { sections } from '../orchestrator/brief.js';
import { roleFor, levelFor, ROLES } from '../agents/roles.js';

const FINISHED = new Set(['merged', 'review', 'approved']);
// Finished enough to skip a step: merged/approved, or a planned step whose run is in review. A bare coder
// run (no plan source, title = the raw instruction) only "ended", so it never counts (code review).
const counts = (t) => t.status === 'merged' || t.status === 'approved' || (t.status === 'review' && Boolean(t.source));
const STOP = new Set('a an the and or of to for in on with into from by at as is are be it its this that my our your new add make build create write set up use using do'.split(' '));

// Lines under a heading: numbered, bulleted or plain; markdown marks and empty lines dropped.
function listItems(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/[*_`]+/g, '').trim()).filter((l) => l && !/^#/.test(l));
}

export function stepsFromBrief(brief) {
  const s = sections(String(brief || '').replace(/^##\s*(.+?)\s*\([^)]*\)\s*$/gm, '## $1'), ['Goal', 'Steps', 'Look & feel', 'Examples', 'Security rules', 'Done when']);
  return { steps: listItems(s.Steps).slice(0, 30), doneWhen: listItems(s['Done when']).slice(0, 20) };
}

// Phase 3: a step has a ROLE (plugins/agents/roles.js), never an agent. The owner is filled in when an
// agent takes the task, or now when the user named one ("plan X with Codex") for the roles it can do.
export const roleCounts = (tasks) => ROLES.map((r) => [r, tasks.filter((t) => t.role === r).length]).filter(([, n]) => n).map(([r, n]) => `${n} ${r}`).join(', ');

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w) && w.length > 1) || [];
// A finished task that already covers this step: the two titles share most of their meaningful words, both
// ways (so "fix login page styling" is not "add login page"), and the step has at least two of them.
export function similarDone(step, tasks) {
  const want = new Set(words(step));
  if (want.size < 2) return null;
  let best = null;
  for (const t of tasks || []) {
    if (!counts(t)) continue;
    const have = new Set(words(t.title));
    const both = [...want].filter((w) => have.has(w)).length;
    const share = both / new Set([...want, ...have]).size;
    if (share >= 0.6 && (!best || share > best.share)) best = { task: t, share };
  }
  return best ? best.task : null;
}

const nextId = (tasks) => {
  const n = Math.max(0, ...tasks.map((t) => Number(/^T-(\d+)$/.exec(t.id)?.[1] || 0)));
  return (k) => `T-${String(n + k).padStart(3, '0')}`;
};

// Steps → planned tasks. A step that is finished on the board, or already planned with the same title, is
// not added again. Each new task depends on the one before it.
// agent: the user's named agent; can: { agentId: [roles] } from the team, so it only goes on steps it can do.
export function planFromSteps(ps, steps, { doneWhen = [], agent = null, can = {}, source = 'brief' } = {}) {
  const board = ps.tasks();
  const id = nextId(board);
  const added = [];
  const skipped = [];
  let prev = null;
  let k = 0;
  for (const step of steps) {
    const done = similarDone(step, board);
    if (done) { skipped.push({ step, done: done.id }); prev = done.id; continue; }
    const same = board.find((t) => String(t.title).toLowerCase() === String(step).toLowerCase() && !['cancelled', 'failed'].includes(t.status));
    if (same) { prev = same.id; continue; }
    k += 1;
    const role = roleFor(step);
    const owner = agent && (!can[agent] || can[agent].includes(role)) ? agent : null;
    const task = { id: id(k), title: step, role, ...(role === 'build' ? { level: levelFor(step) } : {}), owner, status: 'planned', depends_on: prev ? [prev] : [], source };
    added.push(task);
    prev = task.id;
  }
  if (added.length && doneWhen.length) added[added.length - 1].acceptance_criteria = doneWhen;
  for (const t of added) ps.upsertTask(t);
  return { added, skipped };
}

// Planned tasks whose every dependency the user approved (Phase 4: a task in review waits for the user's
// yes; nothing after it starts until then).
const PASSED = new Set(['approved', 'merged']);
export function readyTasks(tasks) {
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  return (tasks || []).filter((t) => t.status === 'planned' && (t.depends_on || []).every((d) => PASSED.has(byId.get(d)?.status)));
}

// What one agent is given for one task (spec: "never send a vague instruction").
export function taskPackage(ps, taskId, { allowed = [], forbidden = ['.env', '.env.*', 'data/', '*.pem', '*.key'] } = {}) {
  const tasks = ps.tasks();
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return null;
  const p = ps.project() || {};
  const done = tasks.filter((x) => FINISHED.has(x.status) && x.id !== t.id).slice(0, 12);
  const dec = ps.decisions().slice(-10);
  return [
    'PROJECT CONTEXT',
    `- Project: ${p.name || '?'} (${p.id || '?'})`,
    `- Goal: ${p.goal || '(not written yet)'}`,
    p.tech_stack?.length ? `- Tech stack: ${p.tech_stack.join(', ')}` : '',
    p.current_branch ? `- Branch: ${p.current_branch}` : '',
    `- Completed work (already built; extend it, do not rebuild it):${done.length ? '' : ' none yet'}`,
    ...done.map((x) => `  - ${x.title} (${x.owner || '?'})${x.summary ? `: ${x.summary}` : ''}`),
    `- Decisions you must follow:${dec.length ? '' : ' none yet'}`,
    ...dec.map((d) => `  - ${d.title}: ${d.decision}`),
    '',
    'TASK',
    `- Task ID: ${t.id}`,
    `- Title: ${t.title}`,
    `- Role: ${t.role || 'build'}${t.owner ? ` (${t.owner})` : ''}`,
    t.depends_on?.length ? `- Depends on: ${t.depends_on.join(', ')}` : '',
    `- Acceptance criteria:${t.acceptance_criteria?.length ? '' : ' the step works and its tests pass'}`,
    ...(t.acceptance_criteria || []).map((c) => `  - ${c}`),
    allowed.length ? `- Files you may change: ${allowed.join(', ')}` : '',
    `- Files you must not touch: ${forbidden.join(', ')}`,
    '',
    'CONSTRAINTS',
    '- Do not rebuild completed work; check the project before adding anything.',
    '- Do not change files outside this task.',
    '- Do not commit or push; Novi asks the user.',
    '- Do not read or print secrets (.env, keys, tokens).',
    '- If anything is unclear, ask instead of guessing.',
    '- End your answer with this report, these exact headings: "Files changed:" (a list, or none), "Tests:" (what you ran and the result, or none), "Risks:" (a list, or none), "Questions:" (a list, or none).',
  ].filter((l) => l !== '').join('\n');
}
