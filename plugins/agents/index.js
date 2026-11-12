// The team plugin (multi-agent orchestrator, Phase 3, 2026-11-11): the agent list, the runner that sends a
// project's ready tasks to the agent of their role, and two tools: project_run ("run the X tasks", "…with
// Codex", "…without ChatGPT") and project_agents ("which agents do you have"). After a build step's coder
// run ends, the runner carries on with the next tasks by itself.
import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { openProjectState } from '../project-state/state.js';
import { readyTasks } from '../project-state/planner.js';
import { createGaps } from '../../server/brain/gaps.js';
import { createRegistry } from './registry.js';
import { createRunner } from './runner.js';
import { buildAdapters, defaultExec } from './adapters.js';
import { agentWords } from './roles.js';
import { setTeam } from './team.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

export function createAgentsPlugin({ exec = defaultExec } = {}) {
  return definePluginEntry({
    id: 'agents',
    name: 'The team',
    description: 'The agents Novi can give work to (Claude, Codex, ChatGPT, Gemini, Perplexity, the backup AI…), by role, and the runner that sends a project\'s tasks to them.',
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(m);
      const registry = createRegistry();
      for (const a of buildAdapters({ rt, exec, log })) registry.add(a);
      setTeam(registry);
      const gaps = rt.gaps || (rt.dataDir ? createGaps({ file: path.join(rt.dataDir, 'gaps', 'gaps.jsonl') }) : null);
      const runner = createRunner({ registry, say: (t) => rt.say?.(t, { kind: null }), gaps, log, tasks: rt.tasks });
      const find = (name) => rt.codingProject?.(name) || (rt.projects?.list?.() || []).find((p) => String(p.name).toLowerCase() === String(name || '').toLowerCase()) || null;
      const there = (p) => Boolean(p?.path && fs.existsSync(p.path) && fs.existsSync(path.join(p.path, '.novi', 'tasks.json')));
      const key = (p) => path.resolve(String(p || '')).toLowerCase();
      const running = new Map(); // project key → { opts, runId, busy } (busy: the runner is mid-run; runId: a build step waits for that coder run)
      const names = () => registry.list().flatMap((a) => [a.name, ...(a.aliases || [])]);

      // Resolve the user's agent words to team members (any spelling, several names with and/or); an
      // unknown name is said, never guessed.
      const resolve = ({ agent, avoid, said }) => {
        const w = said ? agentWords(said, names()) : { prefer: [], avoid: [], unknown: [] };
        const prefer = [];
        const avoided = [];
        const unknown = [...w.unknown];
        const put = (list, name) => { const a = registry.find(name); if (a) { if (!list.includes(a.id)) list.push(a.id); } else unknown.push(name); };
        for (const id of w.prefer) put(prefer, id);
        for (const id of w.avoid) put(avoided, id);
        for (const [text, list] of [[agent, prefer], [avoid, avoided]]) for (const name of String(text || '').split(/\s*(?:,|\band\b|\bor\b)\s*/).filter(Boolean)) put(list, name);
        return { prefer, avoid: avoided, unknown };
      };
      const teamLine = () => registry.list().map((a) => a.name).join(', ');

      const runProject = async (p, opts) => {
        const ps = openProjectState(p.path);
        const k = key(p.path);
        running.set(k, { opts, busy: true, runId: null });
        try {
          const out = await runner.run(ps, opts);
          if (out.started) {
            const runId = ps.tasks().find((t) => t.id === out.started.id)?.agent_run || null;
            running.set(k, { opts, busy: false, runId });
          } else running.delete(k);
          if (!out.started && !out.blocked) {
            const left = ps.tasks().filter((t) => ['planned', 'assigned'].includes(t.status)).length;
            rt.notice?.({ key: `agents-${p.name}`, title: `${p.name}: ${out.done.length} task${out.done.length === 1 ? '' : 's'} done`, body: left ? `${left} waiting.` : 'Nothing left on the board.' });
          }
          return out;
        } catch (err) {
          running.delete(k);
          log(`[agents] ${p.name}: ${err.message}`);
          rt.say?.(`The team stopped on ${p.name}: ${err.message}`, { kind: null });
          return { error: err.message };
        }
      };

      // The coder finished the build step the runner started (that run, not any other task on the project):
      // carry on with the next tasks; a failed or stopped run is said.
      rt.tasks?.on?.('task', (t) => {
        if (!t?.path || !['done', 'failed', 'stopped'].includes(t.status)) return;
        const k = key(t.path);
        const r = running.get(k);
        if (!r || r.busy || !r.runId || r.runId !== t.id) return;
        running.delete(k);
        if (t.status !== 'done') { rt.say?.(`${t.agent || 'The coder'} ${t.status === 'failed' ? 'failed' : 'stopped'} on ${t.project}. Say "run the ${t.project} tasks" to try again.`, { kind: null }); return; }
        setTimeout(() => runProject({ name: t.project, path: t.path }, r.opts).catch(() => {}), 500);
      });

      api.registerTool({
        name: 'project_run',
        description: "Run the project's ready tasks with the team: each task goes to the agent of its role (research, plan, build, review). agent = the one the user named (it wins), avoid = one they ruled out.",
        parameters: obj({ project: str('Project name'), agent: str('Agent the user named, e.g. codex, perplexity'), avoid: str('Agent the user ruled out'), said: str("The user's own words, for agent names in them") }, ['project']),
        async execute(_id, { project, agent, avoid, said } = {}) {
          const p = find(project);
          if (!p?.path || !fs.existsSync(p.path)) return reply('', { error: `I don't know a project called "${project}" with a folder.` });
          if (!there(p)) return reply('', { error: `${p.name} has no task board yet. Say "plan the ${p.name} project" first.` });
          const opts = resolve({ agent, avoid, said });
          if (opts.unknown.length) return reply('', { error: `I don't have an agent called ${opts.unknown.join(' or ')}. The team: ${teamLine()}.` });
          if (running.has(p.path) || running.has(key(p.path))) return reply('', { note: `${p.name} is already running${running.get(key(p.path))?.runId ? ': a build step is with the coder. I\'ll carry on when it finishes' : ''}.` });
          const ps = openProjectState(p.path);
          // "Run" is the user's retry: tasks blocked earlier (no agent, Chrome off…) get another go.
          for (const t of ps.tasks()) if (t.status === 'blocked') ps.upsertTask({ id: t.id, status: 'planned', note: '' });
          const ready = readyTasks(ps.tasks()).sort((a, b) => a.id.localeCompare(b.id));
          if (!ready.length) {
            const blocked = ps.tasks().filter((t) => t.status === 'blocked');
            return reply('', { note: blocked.length ? `Nothing is ready on ${p.name}: ${blocked.length} blocked (${blocked[0].note || blocked[0].title}).` : `Nothing is ready to run on ${p.name}.` });
          }
          const first = ready[0];
          const picked = await registry.pick(first.role || 'build', { prefer: first.owner ? [...opts.prefer, first.owner] : opts.prefer, avoid: opts.avoid });
          if (!picked.agent) return reply('', { error: `I can't find an agent for ${first.role} on ${p.name}: ${picked.gap}. The team: ${teamLine()}.` });
          runProject(p, { prefer: opts.prefer, avoid: opts.avoid }).catch(() => {});
          return reply('', { note: `Starting ${first.id} (${first.role}) with ${picked.agent.name}${ready.length > 1 ? `, then ${ready.length - 1} more` : ''}. I'll tell you as each one finishes.`, started: first.id, agent: picked.agent.id });
        },
      });

      api.registerTool({
        name: 'project_agents',
        description: 'The team Novi can give work to: each agent, what it can do (research, plan, build, review) and whether it is available right now.',
        parameters: obj({}),
        async execute() {
          const list = await registry.status();
          const lines = list.map((a) => `${a.name}: ${a.roles.join(', ')} (${a.ok ? 'ready' : a.why})`);
          return reply('', { note: `The team:\n${lines.join('\n')}`, agents: list });
        },
      });

      // Asked by the AI (not the user's own words): starting the team changes the project.
      api.on('before_tool_call', async ({ toolName, params }) => {
        if (toolName !== 'project_run') return null;
        const title = `Run the ${params?.project || 'project'} tasks with the team?`;
        return { requireApproval: { title, prompt: title, description: 'Each ready task goes to the agent of its role; build steps start the coder.', severity: 'warning', category: 'code', grantable: false } };
      });
    },
  });
}

export default createAgentsPlugin();
