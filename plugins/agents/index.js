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
import { agentWords, roleVerb } from './roles.js';
import { setTeam } from './team.js';
import { checkTask, reviewCard } from './review.js';
import { createCopies, createLocks, RISKY } from './copies.js';
import { createRecord } from './record.js';
import { consentKey } from './opencode.js';
import { siteAdapter } from './learned.js';
import { pickTab } from '../project-import/gather.js';
import { SITES as sites } from '../orchestrator/siteDriver.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const reply = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

// review: { changes, runTests } for tests (defaults read git and run the project's own tests).
// learnSleep: for tests (the learned-site waits).
export function createAgentsPlugin({ exec = defaultExec, review: checkers = {}, learnSleep = null } = {}) {
  return definePluginEntry({
    id: 'agents',
    name: 'The team',
    description: 'The agents Novi can give work to (Claude, Codex, ChatGPT, Gemini, Perplexity, the backup AI…), by role, and the runner that sends a project\'s tasks to them.',
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(m);
      const store = (name) => (rt.dataDir ? path.join(rt.dataDir, 'agents', name) : null);
      // The team's track record (your approvals per coder and difficulty) and your yes/no to free models per project.
      const record = createRecord({ file: store('record.json') });
      const consented = (() => { try { return JSON.parse(fs.readFileSync(store('consent.json'), 'utf8')); } catch { return {}; } })();
      const consentAsks = new Map(); // project → the card already waiting (one card per project)
      const consent = async (project) => {
        // Kept per project folder (two projects called Foo are not one consent; security review 2026-11-12).
        const k = consentKey(find(project) || { name: project });
        if (k in consented) return consented[k];
        if (!rt.ask) return false;
        if (!consentAsks.has(k)) {
          consentAsks.set(k, (async () => {
            const title = `Use free AI models on ${project}?`;
            const d = await rt.ask({ title, prompt: `Free coding models may learn from ${project}'s code. Use them for the easy tasks on ${project}?`, detail: 'Free models (OpenCode: DeepSeek, GLM…) do the easy work so Claude\'s usage goes to the hard parts. Their providers may use what they see to improve their models. Your answer is remembered for this project.', source: 'agents' });
            if (d?.closed || d?.timedOut) return false; // not answered: asked again next time
            consented[k] = Boolean(d?.allow);
            try { fs.mkdirSync(path.dirname(store('consent.json')), { recursive: true }); fs.writeFileSync(store('consent.json'), `${JSON.stringify(consented, null, 2)}\n`); } catch { /* remembered for this run */ }
            return consented[k];
          })().finally(() => consentAsks.delete(k)));
        }
        return consentAsks.get(k);
      };
      const registry = createRegistry({ record });
      for (const a of buildAdapters({ rt, exec, log, consent })) registry.add(a);
      setTeam(registry);
      const gaps = rt.gaps || (rt.dataDir ? createGaps({ file: path.join(rt.dataDir, 'gaps', 'gaps.jsonl') }) : null);
      // Phase 5: each coder that can gets its own copy of the project (outside it, in Novi's data folder);
      // locks keep two tasks off one file; Claude's runs for the team are marked so they get no second
      // commit card (the review card's yes commits them).
      const copies = createCopies({ root: path.join(rt.dataDir || path.join(process.cwd(), 'data'), 'agents', 'copies') });
      const locks = createLocks();
      const teamRuns = new Set();
      rt.teamRun = (id) => teamRuns.has(id);
      const runner = createRunner({ registry, say: (t) => rt.say?.(t, { kind: null }), gaps, log, tasks: rt.tasks, record, copies, locks, onRun: (id) => teamRuns.add(id) });
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

      // Phase 4: a finished task is checked by Novi, then one card asks the user. Approve → the next tasks run;
      // "change X" → the same task runs again with X; no → it waits for changes and nothing after it starts.
      const asking = new Set(); // "<project key>:<task id>" while its card waits
      const own = (ps, file) => Boolean(file) && path.resolve(file).toLowerCase().startsWith(path.join(ps.dir, 'outputs').toLowerCase() + path.sep);
      const reviewProject = async (p, opts) => {
        const ps = openProjectState(p.path);
        const waiting = ps.tasks().filter((t) => t.status === 'review' && t.role && !asking.has(`${key(p.path)}:${t.id}`)).sort((a, b) => a.id.localeCompare(b.id));
        if (!waiting.length || !rt.ask) return false;
        const t = waiting[0];
        const tag = `${key(p.path)}:${t.id}`;
        asking.add(tag);
        try {
          const output = own(ps, t.output) && fs.existsSync(t.output) ? fs.readFileSync(t.output, 'utf8') : '';
          // A build is checked where it was done: its own copy (only what it changed), or your folder.
          const work = t.role === 'build' ? copies.find({ dir: p.path, taskId: t.id }) : null;
          let seen = null; // what the card shows, exactly: the yes covers only that (security review)
          const changes = work ? { changes: async () => { const list = await copies.changes(work); seen = Object.fromEntries(list.map((c) => [c.file, c.hash])); return list.map((c) => ({ file: c.file })); } } : {};
          const check = await checkTask({ task: t, dir: work?.copy ? work.path : p.path, output, ...changes, ...checkers });
          if (check.files?.length) locks.claim(t.id, check.files); // held until your answer
          if (work && !work.copy && check.files?.length) check.risks = [...(check.risks || []), 'It worked in your own folder, so anything you or other tasks changed there meanwhile is in this list too.'];
          const agentName = registry.find(t.owner)?.name || t.owner || 'The agent';
          const commits = t.role === 'build' && Boolean(work) && Boolean(check.files?.length) && Boolean(rt.commitFiles);
          const d = await rt.ask(reviewCard({ project: p.name, task: t, agentName, check, output, commits }));
          if (halted.has(key(p.path))) {
            // You stopped the team while this card waited: nothing moves, nothing restarts (code review).
            rt.say?.(`The team on ${p.name} is stopped, so ${t.id} stays waiting. Say "run the ${p.name} tasks" to go on.`, { kind: null });
            return true;
          }
          asking.delete(tag); // answered: a re-run of this task gets its own card
          if (d?.allow) {
            record.note(t.owner, t.level, 'pass');
            if (work) {
              // Your yes (user, 2026-11-12: "every commit under me … automated and done by all but pushed under
              // my name"): the task's files come back into your folder, then Novi commits them as you and pushes.
              const back = await copies.bringBack(work, { seen });
              if (back.changed) {
                ps.upsertTask({ id: t.id, status: 'review' });
                rt.say?.(`${t.id}'s files changed after I showed you the card, so nothing was brought in. Here it is again.`, { kind: null });
                asking.delete(tag);
                await reviewProject(p, opts);
                return true;
              }
              if (!back.ok) {
                const list = back.clash.slice(0, 3).join(', ');
                ps.upsertTask({ id: t.id, status: 'planned', feedback: `Redo this on top of the current files: ${list} changed in the project since you started.` }, { redact: true });
                await copies.close(work).catch(() => {});
                locks.release(t.id);
                rt.say?.(`${t.id} clashes with changes in ${list} made since it started, so I'm having ${agentName} redo it on top of them.`, { kind: null });
                await runProject(p, opts);
                return true;
              }
              let committed = null;
              const risky = back.files.filter((f) => RISKY.test(f));
              if (back.files.length && rt.commitFiles) committed = await rt.commitFiles({ path: p.path, name: p.name, files: back.files, message: `${t.id}: ${t.title}`, push: !risky.length }).catch((err) => ({ ok: false, note: err.message }));
              if (committed?.ok && risky.length) committed.note = `Committed, but not pushed: it changes ${risky.slice(0, 3).join(', ')}, which decide what runs. Look at it, then say "push my code".`;
              ps.upsertTask({ id: t.id, status: committed?.ok ? 'merged' : 'approved', feedback: '', ...(committed?.commit ? { commit: committed.commit } : {}) });
              if (committed?.commit) mergedLog({ project: key(p.path), task: t.id, commit: committed.commit });
              await copies.close(work).catch(() => {});
              locks.release(t.id);
              if (committed?.note) rt.say?.(`${t.id}: ${committed.note}`, { kind: null });
            } else {
              ps.upsertTask({ id: t.id, status: 'approved', feedback: '' });
              locks.release(t.id);
            }
            log(`[agents] ${p.name}: ${t.id} approved`);
            await runProject(p, opts);
          } else if (d?.change) {
            record.note(t.owner, t.level, 'back');
            ps.upsertTask({ id: t.id, status: 'planned', feedback: d.change }, { redact: true });
            rt.say?.(`Okay, sending ${t.id} back to ${agentName}: ${d.change}`, { kind: null });
            await runProject(p, opts);
          } else if (d?.closed || d?.timedOut) {
            // Novi closed the card (not the user's no): the task stays in review; "run" brings the card back.
            log(`[agents] ${p.name}: ${t.id} card closed without an answer`);
          } else {
            record.note(t.owner, t.level, 'back');
            ps.upsertTask({ id: t.id, status: 'changes_requested' });
            locks.release(t.id);
            if (work) await copies.close(work).catch(() => {});
            rt.say?.(`Okay, ${t.id} waits. Tell me what to change ("change …"), or say "run the ${p.name} tasks" to try it again.`, { kind: null });
          }
          return true;
        } finally { asking.delete(tag); }
      };

      const ended = new Map(); // project key → coder runs that ended while the runner was still busy there
      const resume = new Map(); // project key → opts, for tasks that waited for a coder already in that folder
      const controls = new Map(); // project key → AbortController of the run going on there
      const halted = new Set(); // projects you stopped: a card answered later moves nothing; "run" clears it
      // The commits your yes made, in order, kept in Novi's own data folder: an agent can write the project's
      // board, so undo never trusts a hash from there (security review).
      const mergedFile = store('merged.json');
      const mergedRead = () => { try { return JSON.parse(fs.readFileSync(mergedFile, 'utf8')); } catch { return []; } };
      const mergedLog = (row) => {
        if (!mergedFile) return;
        try { fs.mkdirSync(path.dirname(mergedFile), { recursive: true }); fs.writeFileSync(mergedFile, JSON.stringify([...mergedRead(), { ...row, at: new Date().toISOString() }].slice(-500))); } catch { /* best effort */ }
      };
      const runProject = async (p, opts) => {
        const ps = openProjectState(p.path);
        const k = key(p.path);
        const ctl = new AbortController();
        controls.set(k, ctl);
        const mine = { opts, busy: true, runId: null };
        running.set(k, mine);
        const leave = () => { if (running.get(k) === mine) running.delete(k); };
        try {
          const out = await runner.run(ps, { ...opts, signal: ctl.signal });
          if (controls.get(k) === ctl) controls.delete(k);
          if (ctl.signal.aborted) { leave(); return out; } // you stopped it: no cards, no carrying on
          if (out.started) {
            const runId = ps.tasks().find((t) => t.id === out.started.id)?.agent_run || null;
            const gone = runId ? ended.get(k)?.get(runId) : null;
            if (gone) {
              // Claude finished while the copies were still working (code review): carry on now.
              ended.get(k).delete(runId);
              leave();
              if (gone !== 'done') { rt.say?.(`The coder ${gone} on ${p.name}. Say "run the ${p.name} tasks" to try again.`, { kind: null }); return out; }
              setTimeout(() => { if (!halted.has(k)) runProject(p, opts).catch(() => {}); }, 500);
              return out;
            }
            mine.busy = false;
            mine.runId = runId;
            return out;
          }
          if (out.waiting?.length) {
            resume.set(k, opts);
            rt.say?.(`${out.waiting.join(', ')} on ${p.name} ${out.waiting.length === 1 ? 'waits' : 'wait'}: a coder is already working in that folder. I'll start when it finishes.`, { kind: null });
          }
          // The project stays taken while a card waits, so a second "run" can't start another runner (code review).
          const reviewed = await reviewProject(p, opts);
          leave();
          if (reviewed) return out; // tasks that finished next to a blocked one still get their card
          if (out.blocked) return out;
          const left = ps.tasks().filter((t) => ['planned', 'assigned', 'review', 'changes_requested'].includes(t.status)).length;
          rt.notice?.({ key: `agents-${p.name}`, title: `${p.name}: the team is done for now`, body: left ? `${left} still on the board.` : 'Everything on the board is approved.' });
          return out;
        } catch (err) {
          leave();
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
        if (r?.busy && teamRuns.has(t.id)) { if (!ended.has(k)) ended.set(k, new Map()); ended.get(k).set(t.id, t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : 'stopped'); return; }
        if (!r && resume.has(k)) { const opts = resume.get(k); resume.delete(k); setTimeout(() => runProject({ name: t.project, path: t.path }, opts).catch(() => {}), 500); return; }
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
          halted.delete(key(p.path));
          for (const t of ps.tasks()) if (['blocked', 'changes_requested', 'failed'].includes(t.status) || (t.status === 'cancelled' && t.agent_run && !/^Undone/.test(t.note || ''))) ps.upsertTask({ id: t.id, status: 'planned', note: '' });
          const ready = readyTasks(ps.tasks()).sort((a, b) => a.id.localeCompare(b.id));
          // A task still waiting for the user's yes (its card was lost to a restart or closed): ask again.
          const owed = ps.tasks().filter((t) => t.status === 'review' && t.role);
          if (!ready.length && owed.length) {
            reviewProject(p, { prefer: opts.prefer, avoid: opts.avoid }).catch((err) => log(`[agents] ${p.name}: review card: ${err.message}`));
            return reply('', { note: `${owed[0].id} on ${p.name} is waiting for your yes. I'll show you its card.` });
          }
          if (!ready.length) {
            const blocked = ps.tasks().filter((t) => t.status === 'blocked');
            return reply('', { note: blocked.length ? `Nothing is ready on ${p.name}: ${blocked.length} blocked (${blocked[0].note || blocked[0].title}).` : `Nothing is ready to run on ${p.name}.` });
          }
          const first = ready[0];
          const picked = await registry.pick(first.role || 'build', { prefer: first.owner ? [...opts.prefer, first.owner] : opts.prefer, avoid: opts.avoid, level: first.level, project: p.name });
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

      // New AIs join by themselves (2026-11-12): a chat-shaped site the user has open that isn't on the team is
      // tested with one tiny question; if it answers, one card asks; yes = a member (kept in learned.json), no =
      // never asked about that site again. Nothing here knows any site.
      const learnedFile = store('learned.json');
      const learned = (() => { try { return { members: [], offered: {}, ...JSON.parse(fs.readFileSync(learnedFile, 'utf8')) }; } catch { return { members: [], offered: {} }; } })();
      const saveLearned = () => { try { fs.mkdirSync(path.dirname(learnedFile), { recursive: true }); fs.writeFileSync(learnedFile, `${JSON.stringify(learned, null, 2)}\n`); } catch { /* kept for this run */ } };
      const join = (spec) => registry.add(siteAdapter(spec, { rt, ...(learnSleep ? { sleep: learnSleep } : {}) }));
      for (const m of learned.members) join(m);
      const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };
      const onTeam = (host) => registry.list().some((a) => (a.aliases || []).some((x) => String(x).toLowerCase() === host) || String(sites[a.id]?.url || '').includes(host)) || learned.members.some((m) => m.host === host);
      const known = new Set(Object.values(sites).map((s) => hostOf(s.url)).filter(Boolean));
      const NOVI_HOSTS = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$|\.ts\.net(?::\d+)?$/i;
      const nameOf = (tab, host) => String(tab.title || host).split(/\s[-|–]\s/)[0].trim().slice(0, 40) || host;
      // Try one site: a tiny question; it must answer READY. Then the card.
      const tryJoin = async (tab) => {
        const host = hostOf(tab.url);
        const spec = { host, url: `https://${host}/`, name: nameOf(tab, host) };
        const probe = siteAdapter(spec, { rt, ...(learnSleep ? { sleep: learnSleep } : {}), maxMs: 60_000 });
        const test = await probe.run('Reply with just the word READY.').catch((err) => ({ ok: false, error: err.message }));
        // Any case: live, Perplexity answered "ready".
        if (!test.ok || !/\bready\b/i.test(test.output || '')) { log(`[agents] couldn't learn ${host}: ${test.error || 'no READY'}`); return { host, ok: false }; }
        learned.offered[host] = new Date().toISOString();
        saveLearned();
        const d = rt.ask ? await rt.ask({ title: `Add ${spec.name} to the team?`, prompt: `You use ${spec.name}. I tried it and it answers. Add it to the team for research, plans and reviews?`, detail: `${spec.url}\nIt would get research, plan and review tasks, which include the project's goal, finished work and decisions (never .env files or keys).\nIt starts with no track record, so it gets work only after the others, until your approvals move it up.`, source: 'agents' }) : { allow: false };
        if (!d?.allow) return { host, ok: true, joined: false };
        learned.members.push(spec);
        saveLearned();
        join(spec);
        log(`[agents] ${spec.name} (${host}) joined the team`);
        return { host, ok: true, joined: true, name: spec.name };
      };
      const discover = async () => {
        if (!rt.browserRequest || !rt.browserStatus?.().connected) return { note: "Chrome isn't connected, so I can't look for new AIs." };
        const { tabs = [] } = await rt.browserRequest('tabs', {});
        const fresh = [];
        for (const tab of tabs) {
          const host = hostOf(tab.url);
          if (!host || !/^https:/i.test(tab.url || '') || NOVI_HOSTS.test(host) || known.has(host) || onTeam(host) || learned.offered[host] || fresh.some((t) => hostOf(t.url) === host)) continue;
          // Only the page's shape is read (a chat box and long answers?), never its content.
          const shape = await rt.browserRequest('chatShape', { tabId: tab.id }).catch(() => null);
          if (shape?.chat) fresh.push(tab);
        }
        const joined = [];
        for (const tab of fresh.slice(0, 3)) { const r = await tryJoin(tab); if (r.joined) joined.push(r.name); }
        return { note: joined.length ? `${joined.join(' and ')} joined the team.` : fresh.length ? "I found new AI sites but couldn't learn them, or you said no." : 'Nothing new to add to the team.' };
      };

      api.registerTool({
        name: 'team_discover',
        description: 'Look at the open Chrome tabs for AI sites that are not on the team yet; test each, then ask the user to add it.',
        parameters: obj({}),
        async execute() { try { return reply('', await discover()); } catch (err) { return reply('', { error: err.message }); } },
      });
      api.registerTool({
        name: 'team_add',
        description: 'Add an AI the user names (a site name or address) to the team: found in the open Chrome tabs, tested, then one card.',
        parameters: obj({ name: str('The AI in the user\'s words, or its address') }, ['name']),
        async execute(_id, { name } = {}) {
          if (!rt.browserRequest || !rt.browserStatus?.().connected) return reply('', { error: "Chrome isn't connected, so I can't add a site." });
          let tab = null;
          if (/^https?:\/\//i.test(name)) tab = { url: name, title: hostOf(name) };
          else {
            const { tabs = [] } = await rt.browserRequest('tabs', {});
            tab = pickTab(tabs, name, ['localhost:', '.ts.net', 'chrome-extension:']);
          }
          if (!tab) return reply('', { error: `I can't find ${name} in your open Chrome tabs. Open it once, then ask again (or tell me its address).` });
          if (onTeam(hostOf(tab.url))) return reply('', { note: `${nameOf(tab, hostOf(tab.url))} is already on the team.` });
          delete learned.offered[hostOf(tab.url)];
          const r = await tryJoin(tab);
          if (!r.ok) return reply('', { error: `I couldn't learn ${name}: it didn't answer my test question. It may need you to log in there first.` });
          return reply('', { note: r.joined ? `${r.name} joined the team.` : `Okay, I won't add ${name}.` });
        },
      });
      // Every 6 hours (first one 10 minutes after start) while Chrome is connected.
      api.registerService({
        id: 'agents-discover',
        start: () => {
          if (process.env.VITEST) return;
          const tick = () => discover().then((r) => { if (/joined/.test(r.note || '')) rt.say?.(r.note, { kind: null }); }).catch((err) => log(`[agents] discover: ${err.message}`));
          const first = setTimeout(tick, 10 * 60_000);
          const every = setInterval(tick, 6 * 60 * 60_000);
          first.unref?.(); every.unref?.();
          return { stop: () => { clearTimeout(first); clearInterval(every); } };
        },
      });

      // Asked by the AI (not the user's own words): starting the team changes the project.
      // ---- Phase 6: the team by voice ----
      const boards = (project) => {
        const list = project ? [find(project)].filter(Boolean) : (rt.projects?.list?.() || []);
        return list.filter((p) => there(p)).map((p) => ({ p, ps: openProjectState(p.path) }));
      };
      const agentName = (id) => registry.find(id)?.name || id || 'An agent';

      api.registerTool({
        name: 'project_stop',
        description: 'Stop the team on a project (or on every project): running agents are stopped, their tasks go back to planned, nothing new starts. "Run the X tasks" starts again.',
        parameters: obj({ project: str('Project name; leave out for every project') }),
        async execute(_id, { project } = {}) {
          const targets = project ? [find(project)].filter(Boolean) : (rt.projects?.list?.() || []);
          if (project && !targets.length) return reply('', { error: `I don't know a project called "${project}".` });
          const stopped = [];
          for (const p of targets) {
            const k = key(p.path);
            const r = running.get(k);
            const ctl = controls.get(k);
            if (!r && !ctl && !resume.has(k)) continue;
            ctl?.abort();
            halted.add(k);
            resume.delete(k);
            // A team Claude run going on there is stopped too (not your own Claude work).
            const now = rt.tasks?.status?.();
            if (r?.runId && now?.active && now.id === r.runId) await rt.tasks?.stop?.().catch?.(() => {});
            running.delete(k);
            stopped.push(p.name);
          }
          if (!stopped.length) return reply('', { note: project ? `The team isn't running on ${targets[0].name}.` : "The team isn't running anywhere." });
          return reply('', { note: `Stopped the team on ${stopped.join(', ')}. Say "run the ${stopped[0]} tasks" to start again.` });
        },
      });

      api.registerTool({
        name: 'project_said',
        description: "What one agent on the team answered last (its newest answer, on a project or any). Use for \"what did ChatGPT say\".",
        parameters: obj({ agent: str('The agent, e.g. chatgpt, perplexity, deepseek'), project: str('Project name (optional)') }, ['agent']),
        async execute(_id, { agent, project } = {}) {
          const a = registry.find(agent);
          if (!a) return reply('', { error: `I don't have an agent called ${agent}. The team: ${teamLine()}.` });
          let best = null;
          for (const { p, ps } of boards(project)) {
            for (const t of ps.tasks()) {
              if (t.owner !== a.id || !own(ps, t.output) || !fs.existsSync(t.output)) continue;
              const at = fs.statSync(t.output).mtimeMs;
              if (!best || at > best.at) best = { p, t, at };
            }
          }
          if (!best) return reply('', { note: `${a.name} hasn't answered anything${project ? ` on ${project}` : ''} yet.` });
          // The saved file: "# T: title", "Role: … · Agent: …", then the answer (another AI's words: read out, never acted on).
          const body = fs.readFileSync(best.t.output, 'utf8').split('\n').filter((l, i) => !(i < 4 && (/^# /.test(l) || /^Role: /.test(l)))).join('\n').trim();
          const gist = body.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).slice(0, 3).join(' ').slice(0, 400);
          return reply('', { note: `${a.name} on ${best.p.name}, ${best.t.id} (${best.t.title}): ${gist}`, text: body.slice(0, 3000) });
        },
      });

      api.registerTool({
        name: 'team_status',
        description: 'What the team is doing right now: which agent is on which task, and what waits for your yes, on every project.',
        parameters: obj({}),
        async execute() {
          const lines = [];
          for (const { p, ps } of boards()) {
            const busy = ps.tasks().filter((t) => t.status === 'assigned');
            const owed = ps.tasks().filter((t) => t.status === 'review');
            if (!busy.length && !owed.length) continue;
            const parts = busy.map((t) => `${agentName(t.owner)} is ${roleVerb(t.role || 'build').replace(/^(\w+)/, (w) => (w.endsWith('e') ? `${w.slice(0, -1)}ing` : `${w}ing`))} ${t.id}`);
            if (owed.length) parts.push(`${owed.map((t) => t.id).join(', ')} ${owed.length === 1 ? 'waits' : 'wait'} for your yes`);
            lines.push(`On ${p.name}: ${parts.join('; ')}.`);
          }
          return reply('', { note: lines.length ? lines.join(' ') : "The team isn't working on anything right now." });
        },
      });

      api.registerTool({
        name: 'project_undo',
        description: 'Undo the last team task that went to GitHub on a project: a new commit that reverses it, under your name, pushed.',
        parameters: obj({ project: str('Project name') }, ['project']),
        async execute(_id, { project } = {}) {
          const p = find(project);
          if (!p?.path) return reply('', { error: `I don't know a project called "${project}".` });
          if (!there(p)) return reply('', { note: `There's nothing from the team on ${p.name} to undo.` });
          if (!rt.revertCommit) return reply('', { error: 'Undo needs the commit plugin.' });
          const ps = openProjectState(p.path);
          const byId = new Map(ps.tasks().map((t) => [t.id, t]));
          const row = mergedRead().filter((r) => r.project === key(p.path) && byId.get(r.task)?.status === 'merged').pop();
          const last = row ? { ...byId.get(row.task), commit: row.commit } : null;
          if (!last) return reply('', { note: `There's nothing from the team on ${p.name} to undo.` });
          const r = await rt.revertCommit({ path: p.path, name: p.name, commit: last.commit, subject: `${last.id}:` });
          if (!r?.ok) return reply('', { note: r?.note || `I couldn't undo ${last.id}.` });
          ps.upsertTask({ id: last.id, status: 'cancelled', note: `Undone by you${r.commit ? ` (${r.commit.slice(0, 7)})` : ''}${r.pushed ? '' : ', on the laptop only'}.` }, { redact: true });
          const how = r.pushed ? 'The undo is on GitHub too.' : `It's undone on the laptop, not on GitHub: ${String(r.note || '').replace(/^Committed[^,.]*[,.]\s*/i, '')}`;
          return reply('', { note: `Undid ${last.id} (${last.title}) on ${p.name}. ${how}`.trim() });
        },
      });

      api.on('before_tool_call', async ({ toolName, params, direct }) => {
        // Undo changes your project and GitHub: the AI asks first; your own words are the yes.
        if (toolName === 'project_undo' && !direct) {
          const title = `Undo the last team task on ${params?.project || 'the project'}?`;
          return { requireApproval: { title, prompt: title, description: 'A new commit that reverses it, under your name, pushed to GitHub.', severity: 'warning', category: 'github', grantable: false } };
        }
        if (toolName !== 'project_run') return null;
        const title = `Run the ${params?.project || 'project'} tasks with the team?`;
        return { requireApproval: { title, prompt: title, description: 'Each ready task goes to the agent of its role; build steps start the coder.', severity: 'warning', category: 'code', grantable: false } };
      });
    },
  });
}

export default createAgentsPlugin();
