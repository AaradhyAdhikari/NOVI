// The project record plugin (multi-agent orchestrator, Phase 1). Keeps <project>/.novi/ up to date:
// Claude's and Novi Coder's tasks land on the project's board as they move, a task still running when
// Novi stopped is marked blocked at the next start (never silently lost), and two tools read the board and
// add decisions. Later phases (planner, adapters, merge gate) build on this record.
import fs from 'node:fs';
import { definePluginEntry } from '#plugin-sdk';
import { openProjectState, taskFromCoder } from './state.js';
import { projectFacts } from './facts.js';
import { stepsFromBrief, planFromSteps, readyTasks } from './planner.js';
import { briefFrom } from '../donecheck/report.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
// Board lines are read out: long step titles are cut at a word.
const short = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`; };

export function createProjectStatePlugin({ exec } = {}) {
  return definePluginEntry({
    id: 'project-state',
    name: 'Project record',
    description: 'One record per project in <project>/.novi/: facts, task board, decisions, context and audit log.',
    register(api) {
      const rt = api.runtime || {};
      const warn = (m) => api.logger?.warn?.(m);
      const find = (name) => rt.codingProject?.(name) || (rt.projects?.list?.() || []).find((p) => String(p.name).toLowerCase() === String(name || '').toLowerCase()) || null;
      const stateOf = (p) => {
        const ps = openProjectState(p.path);
        ps.ensure(projectFacts(p.path, { name: p.name, ...(exec ? { exec } : {}) }));
        return ps;
      };
      // Reading the board writes nothing once the record exists.
      const readState = (p) => (openProjectState(p.path).project() ? openProjectState(p.path) : stateOf(p));
      const there = (p) => Boolean(p?.path && fs.existsSync(p.path));

      // Phase 2: a Claude run whose instruction carries an approved brief is planned onto the board the first
      // time Novi sees it, and only the steps planned just then (Claude's) are linked to it. The link is kept on
      // the board (agent_run), so the steps keep moving with the run even after a Novi restart (code review:
      // the run's first event comes before any tool hook, and an old unrun plan must never be touched).
      const planned = new Set(); // run ids already planned
      const planBrief = (p, brief) => {
        const { steps, doneWhen } = stepsFromBrief(brief);
        if (!steps.length) return null;
        return planFromSteps(stateOf(p), steps, { doneWhen });
      };

      // The coder's task moves → the board. Facts are refreshed once per task, not on every move.
      const fresh = new Set();
      rt.tasks?.on?.('task', (t) => {
        const task = taskFromCoder(t);
        if (!task || !t.path || !fs.existsSync(t.path)) return;
        try {
          const p = { name: t.project, path: t.path };
          const ps = fresh.has(t.id) ? openProjectState(p.path) : stateOf(p);
          fresh.add(t.id);
          ps.upsertTask(task, { redact: true });
          const brief = briefFrom(t.instruction);
          if (brief && !planned.has(t.id) && !ps.tasks().some((x) => x.agent_run === t.id)) {
            planned.add(t.id);
            const out = planBrief(p, brief);
            for (const st of (out?.added || []).filter((x) => x.owner === 'claude')) ps.upsertTask({ id: st.id, agent_run: t.id });
          }
          for (const st of ps.tasks().filter((x) => x.agent_run === t.id && x.id !== t.id)) ps.upsertTask({ id: st.id, status: task.status });
        } catch (err) { warn(`[project-state] ${t.project}: ${err.message}`); }
      });

      api.registerService({
        id: 'project-state-recover',
        // A task still "assigned" from before this start was cut off by the restart: say so on the board.
        start: async () => {
          const running = rt.tasks?.status?.();
          for (const p of rt.projects?.list?.() || []) {
            if (!there(p) || !fs.existsSync(`${p.path}/.novi/tasks.json`)) continue;
            try {
              const ps = openProjectState(p.path);
              for (const t of ps.tasks()) {
                if (t.status !== 'assigned' || (running?.active && running.id === t.id && running.status === 'running')) continue;
                ps.upsertTask({ id: t.id, status: 'blocked', note: 'Novi restarted while this was running. Say "continue" to pick it up, or start it again.' });
              }
            } catch (err) { warn(`[project-state] ${p.name}: ${err.message}`); }
          }
        },
      });

      api.registerTool({
        name: 'project_board',
        description: "The project's own record: goal, open and finished tasks with their owners, and its decisions. Use it before planning work so nothing already done is rebuilt.",
        parameters: obj({ project: str('Project name') }, ['project']),
        async execute(_id, { project } = {}) {
          const p = find(project);
          if (!there(p)) return reply('', { error: `I don't know a project called "${project}" with a folder.` });
          const ps = readState(p);
          const tasks = ps.tasks();
          const open = tasks.filter((t) => !['merged', 'cancelled', 'failed'].includes(t.status));
          const done = tasks.filter((t) => t.status === 'merged' || t.status === 'review');
          const dec = ps.decisions();
          const ready = readyTasks(tasks);
          const lines = [
            `${p.name}: ${open.length} open task${open.length === 1 ? '' : 's'}, ${done.length} finished, ${dec.length} decision${dec.length === 1 ? '' : 's'}.`,
            ...open.slice(0, 5).map((t) => `- ${short(t.title)} (${t.status}, ${t.owner || 'unassigned'})`),
            ...(ready.length ? [`Ready to start: ${ready.slice(0, 3).map((t) => `${short(t.title)} (${t.owner})`).join('; ')}.`] : []),
            ...(dec.length ? [`Latest decision: ${dec.at(-1).title}: ${dec.at(-1).decision}.`] : []),
          ];
          return reply('', { note: lines.join('\n'), tasks: tasks.slice(0, 20), decisions: dec.slice(-10), project: ps.project() });
        },
      });

      api.registerTool({
        name: 'project_plan',
        description: "Plan a project from its latest brief (the Novi Memory note \"<Project> brief\"), or from steps given: tasks with owners, dependencies and done-when on the project's board. Steps already finished are not planned again.",
        parameters: obj({ project: str('Project name'), steps: { type: 'array', items: { type: 'string' }, description: 'Optional: the steps, when there is no brief' } }, ['project']),
        async execute(_id, { project, steps } = {}) {
          const p = find(project);
          if (!there(p)) return reply('', { error: `I don't know a project called "${project}" with a folder.` });
          try {
            let out;
            if (Array.isArray(steps) && steps.length) out = planFromSteps(stateOf(p), steps.map(String), { source: 'user' });
            else {
              const brief = rt.wikiRead?.(`${p.name} brief`);
              if (!brief) return reply('', { error: `${p.name} has no brief yet. Say "let's work on ${p.name}" to make one, or tell me the steps.` });
              out = planBrief(p, brief);
              if (!out) return reply('', { error: `The ${p.name} brief has no steps I can plan from.` });
            }
            const who = [...new Set(out.added.map((t) => t.owner))].join(', ');
            const note = [
              out.added.length ? `Planned ${out.added.length} task${out.added.length === 1 ? '' : 's'} for ${p.name}${who ? ` (${who})` : ''}.` : `Nothing new to plan for ${p.name}.`,
              out.skipped.length ? `Already done, so not planned again: ${out.skipped.map((s) => s.step).join('; ')}.` : '',
            ].filter(Boolean).join(' ');
            return reply('', { note, added: out.added, skipped: out.skipped });
          } catch (err) { return reply('', { error: err.message }); }
        },
      });

      api.registerTool({
        name: 'project_decision',
        description: "Write a decision into the project's record (decisions.md), which every agent must respect. Only for decisions the user made or approved.",
        parameters: obj({ project: str('Project name'), title: str('Short title, e.g. "Database"'), decision: str('What was decided'), reason: str('Why') }, ['project', 'title', 'decision']),
        async execute(_id, { project, title, decision, reason = '' } = {}) {
          const p = find(project);
          if (!there(p)) return reply('', { error: `I don't know a project called "${project}" with a folder.` });
          try {
            const d = stateOf(p).addDecision({ title, decision, reason, owner: 'User' });
            return reply('', { note: `Noted the decision for ${p.name}: ${d.title}, ${d.decision}.` });
          } catch (err) { return reply('', { error: err.message }); }
        },
      });

      // Asked by the AI (not the user's own words): writing a decision changes the project's record.
      api.on('before_tool_call', async ({ toolName, params }) => {
        if (toolName !== 'project_decision') return null;
        const title = `Write a decision for ${params?.project || 'the project'}: ${String(params?.decision || '').slice(0, 80)}?`;
        return { requireApproval: { title, prompt: title, description: 'Goes into the project\'s decisions.md, which every agent must follow.', severity: 'warning', category: 'files', grantable: false } };
      });
    },
  });
}

export default createProjectStatePlugin();
