// Routines (2026-11-13, spec docs/superpowers/specs/2026-11-13-novi-routines-design.md): jobs from the
// user's own words that only look things up and tell. The AI plans one once, one card saves it, and then it
// runs by itself: on a time pattern (a missed run catches up once) or when a coding task / a team task
// finishes. Each run replays the same steps through runtime.callTool and reports on a small card.
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { LOOK_TOOLS } from './look.js';
import { createStore } from './store.js';
import { nextRun, describeWhen } from './schedule.js';
import { planRoutine } from './plan.js';
import { createRoutineRunner } from './runner.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const EVENT_GAP_MS = 5 * 60_000;

// startScheduler / tickMs / now: for tests (the timer doesn't start under Vitest unless asked).
export function createRoutinesPlugin({ now = () => new Date(), startScheduler = !process.env.VITEST, tickMs = 60_000 } = {}) {
  return definePluginEntry({
    id: 'routines',
    name: 'Routines',
    description: 'Jobs you describe in words that run by themselves, only look things up, and report on a small card.',
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(m);
      const dir = path.join(rt.dataDir || path.join(process.cwd(), 'data'), 'routines');
      const store = createStore({ file: path.join(dir, 'routines.json') });
      const runner = createRoutineRunner({ callTool: (t, p) => rt.callTool(t, p), privateComplete: rt.privateComplete ? (p) => rt.privateComplete(p) : null, notice: (n) => rt.notice?.(n), store, log, logFile: path.join(dir, 'runs.jsonl'), now });
      const catalog = () => LOOK_TOOLS.map((name) => {
        const info = rt.toolInfo?.(name);
        if (!info) return null;
        const params = Object.keys(info.parameters?.properties || {});
        return `${name}: ${String(info.description || '').slice(0, 160)}${params.length ? ` (params: ${params.join(', ')})` : ''}`;
      }).filter(Boolean);
      const find = (name) => store.byName(name);
      // unknown: the words may not be about a routine at all ("run the tests routine"), so the AI gets them.
      const missing = (name) => reply('', { unknown: true, error: `I have no routine called "${name}". Say "list my routines" to hear them.` });

      // ---- the timer: each routine keeps its own next run; a run missed while Novi was off runs once ----
      const running = new Set();
      const runOne = async (r, fill = {}) => {
        if (running.has(r.id)) return null;
        running.add(r.id);
        try { return await runner.run(store.get(r.id) || r, { fill }); } catch (err) { log(`[routines] ${r.name}: ${err.message}`); return null; } finally { running.delete(r.id); }
      };
      const tick = async () => {
        const t = now();
        for (const r of store.list()) {
          try {
            if (r.paused || r.when?.on) continue;
            const due = r.next_run ? new Date(r.next_run) : null;
            if (!due) { store.update(r.id, { next_run: nextRun(r.when, t)?.toISOString() || null }); continue; }
            if (due > t) continue;
            store.update(r.id, { next_run: nextRun(r.when, t)?.toISOString() || null }); // one catch-up, never one per missed slot
            await runOne(r);
          } catch (err) { log(`[routines] ${r.name}: ${err.message}`); } // one routine's trouble never skips the others
        }
      };
      rt.routinesTick = tick;
      let timer = null;
      if (startScheduler) {
        api.registerService({
          id: 'routines',
          start: () => { tick().catch(() => {}); timer = setInterval(() => { tick().catch(() => {}); }, tickMs); timer.unref?.(); },
          stop: () => clearInterval(timer),
        });
      }

      // ---- events: a coding task finished well, the team finished a task ----
      const lastEvent = new Map();
      rt.routineEvent = async (kind, fill = {}) => {
        const t = now().getTime();
        for (const r of store.list()) {
          if (r.paused || r.when?.on !== kind) continue;
          const key = `${r.id}:${fill.project || ''}`; // per project: two projects finishing close together both count
          if (t - (lastEvent.get(key) || 0) < EVENT_GAP_MS) continue;
          lastEvent.set(key, t);
          await runOne(r, fill);
        }
      };
      const seenTasks = [];
      rt.tasks?.on?.('task', (task) => {
        if (task?.status !== 'done' || !task.id || seenTasks.includes(task.id)) return;
        seenTasks.push(task.id);
        if (seenTasks.length > 200) seenTasks.shift();
        rt.routineEvent('coding_done', { project: task.project || '' }).catch(() => {});
      });

      // ---- tools ----
      api.registerTool({
        name: 'routine_make',
        description: 'Make a routine from the user\'s words: something Novi does by itself on a schedule or when a coding/team task finishes, ONLY looking things up and reporting (never sending, changing or running code). Shows one card with the plan.',
        parameters: obj({ said: str("The user's own words describing the routine") }, ['said']),
        async execute(_id, { said } = {}) {
          if (!rt.complete) return reply('', { error: 'Making a routine needs the AI, and none is set up.' });
          const out = await planRoutine(String(said || ''), { complete: (p) => rt.complete(p), catalog: catalog() });
          if (out.error) return reply('', { error: out.error });
          const r = out.routine;
          const when = describeWhen(r.when);
          const detail = [`Runs ${when}.`, '', ...r.steps.map((s, i) => `${i + 1}. ${s.label} (${s.tool}${Object.keys(s.params).length ? ` ${JSON.stringify(s.params)}` : ''})`), '', `Then it tells you ${r.report}.`, 'It only looks things up and tells you; it never sends, changes or deletes anything.'].join('\n');
          const title = `New routine: ${r.name}?`;
          const d = await rt.ask?.({ title, prompt: title, detail, timeoutMs: 600_000, grantable: false, source: 'routines' });
          if (!d?.allow) return reply('', { note: 'Okay, not saved.' });
          const saved = store.add({ ...r, next_run: nextRun(r.when, now())?.toISOString() || null });
          if (saved.error) return reply('', { error: saved.error });
          log(`[routines] saved ${saved.name} (${when})`);
          return reply('', { note: `Saved. ${saved.name} runs ${when}.` });
        },
      });

      api.registerTool({
        name: 'routine_list',
        description: "The user's routines: name, when, paused or not, and what the last run said.",
        parameters: obj({}),
        async execute() {
          const list = store.list();
          if (!list.length) return reply('', { note: 'You have no routines yet.' });
          const lines = list.map((r) => `${r.name}: ${describeWhen(r.when)}${r.paused ? ' (paused)' : ''}${r.last_report ? `. Last: ${String(r.last_report).split(/(?<=[.!?])\s+/)[0]}` : ''}`);
          return reply('', { note: `You have ${list.length} routine${list.length === 1 ? '' : 's'}. ${lines.join('. ')}` });
        },
      });

      api.registerTool({
        name: 'routine_run',
        description: 'Run one of the user\'s routines now, by name.',
        parameters: obj({ name: str('The routine\'s name') }, ['name']),
        async execute(_id, { name } = {}) {
          const r = find(name);
          if (!r) return missing(name);
          const out = await runOne(r);
          return reply('', { note: out?.report || (out?.quiet ? 'Nothing new since last time.' : `${r.name} didn't finish.`) });
        },
      });

      api.registerTool({
        name: 'routine_said',
        description: 'What a routine said the last time it ran.',
        parameters: obj({ name: str('The routine\'s name') }, ['name']),
        async execute(_id, { name } = {}) {
          const r = find(name);
          if (!r) return missing(name);
          return reply('', { note: r.last_report || `${r.name} hasn't run yet.` });
        },
      });

      api.registerTool({
        name: 'routine_pause',
        description: 'Pause one of the user\'s routines, or resume it (resume: true).',
        parameters: obj({ name: str('The routine\'s name'), resume: { type: 'boolean', description: 'true = run again' } }, ['name']),
        async execute(_id, { name, resume = false } = {}) {
          const r = find(name);
          if (!r) return missing(name);
          if (resume) {
            store.update(r.id, { paused: false, fails: 0, next_run: nextRun(r.when, now())?.toISOString() || null });
            return reply('', { note: `${r.name} runs again, ${describeWhen(r.when)}.` });
          }
          store.update(r.id, { paused: true });
          return reply('', { note: `Paused ${r.name}. Say "resume the ${r.name} routine" to start it again.` });
        },
      });

      api.registerTool({
        name: 'routine_remove',
        description: 'Remove one of the user\'s routines, by name.',
        parameters: obj({ name: str('The routine\'s name') }, ['name']),
        async execute(_id, { name } = {}) {
          const r = find(name);
          if (!r) return missing(name);
          store.remove(r.id);
          return reply('', { note: `Removed ${r.name}.` });
        },
      });

      // Removing asks first when the AI chose it; the user's own words are the yes. Making always shows its card.
      api.on('before_tool_call', async ({ toolName, params, direct }) => {
        if (toolName !== 'routine_remove' || direct) return null;
        const title = `Remove the ${params?.name || 'chosen'} routine?`;
        return { requireApproval: { title, prompt: title, severity: 'warning', category: 'routines', grantable: false } };
      });
    },
  });
}

export default createRoutinesPlugin();
