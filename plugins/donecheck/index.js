import fs from 'node:fs';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { checksFrom } from './checks.js';
import { summary, resultLines, fixMessage, briefFrom } from './report.js';
import { openSite, PHONE, DESKTOP } from './page.js';
import { judge } from './judge.js';

// The done-check (spec docs/superpowers/specs/2026-10-28-novi-done-check-design.md): Brief → Claude
// builds → Novi checks the site against the brief's "Done when" list → says the result honestly →
// "fix it" → Claude fixes only the failed checks → Novi checks again. Claude never grades its own
// work; every run is saved (research numbers: pass rate, fix rounds, time).
const reply = (details) => ({ content: [], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const NOVI = '.novi';
const checksFile = (dir) => path.join(dir, NOVI, 'checks.json');
const resultsFile = (dir) => path.join(dir, NOVI, 'check-results.jsonl');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeChecks(dir, data) {
  fs.mkdirSync(path.join(dir, NOVI), { recursive: true });
  fs.writeFileSync(checksFile(dir), JSON.stringify(data, null, 2));
}
function lastRun(dir) {
  try { return JSON.parse(fs.readFileSync(resultsFile(dir), 'utf8').trim().split('\n').at(-1)); } catch { return null; }
}

export function createDoneCheckPlugin({ open = openSite } = {}) {
  return definePluginEntry({
    id: 'donecheck',
    name: 'Done-check',
    description: "Checks Claude's work against the brief's Done-when list in a hidden browser, says the result, and sends only the failed checks back to Claude.",
    register(api) {
      const rt = api.runtime || {};
      const running = new Set();
      const projectOf = (name) => rt.codingProject?.(name) || null;

      async function runAll(p, c) {
        const t0 = Date.now();
        const round = c.round || 1;
        const site = await rt.previewSite?.(p.name);
        if (!site || site.error) {
          rt.say?.(`I couldn't start the ${p.name} site to check it (${site?.error || 'no preview'}).`, { kind: null });
          return;
        }
        const page = await open(`http://localhost:${site.port}/`);
        const results = [];
        let phone = null;
        try {
          await page.open(DESKTOP);
          const desktop = await page.shot();
          await page.open(PHONE);
          phone = await page.shot();
          const errors = [...page.errors];
          for (const check of c.checks) {
            const r = await judge(check, { page, errors, shots: { phone, desktop }, vision: rt.vision, complete: rt.complete, wait: 800 });
            const png = r.png || (check.kind === 'visual' ? phone : null);
            let shot;
            if (png?.length && (r.state === 'failed' || r.state === 'uncertain')) {
              shot = `${NOVI}/check-shots/${round}-${check.id}.png`;
              fs.mkdirSync(path.join(p.path, NOVI, 'check-shots'), { recursive: true });
              fs.writeFileSync(path.join(p.path, shot), png);
            }
            results.push({ ...check, state: r.state, why: r.why, ...(shot ? { shot } : {}) });
          }
        } finally {
          page.close();
        }
        const at = new Date().toISOString();
        const count = (s) => results.filter((r) => r.state === s).length;
        fs.appendFileSync(resultsFile(p.path), `${JSON.stringify({ at, round, results })}\n`);
        const dataDir = path.join(rt.dataDir || 'data', 'donecheck');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.appendFileSync(path.join(dataDir, 'runs.jsonl'), `${JSON.stringify({ at, project: p.name, round, passed: count('passed'), failed: count('failed'), uncertain: count('uncertain'), notChecked: count('not checked'), seconds: Math.round((Date.now() - t0) / 1000) })}\n`);
        writeChecks(p.path, { ...c, pending: false, round, lastAt: at });
        const said = summary(results);
        const lines = resultLines(results);
        rt.wikiWrite?.({ title: `${p.name} brief`, text: `## Checked ${at.slice(0, 10)} (round ${round}): ${count('passed')}/${results.length} passed\n${lines.join('\n')}` });
        if (phone?.length) rt.showImage?.({ png: phone, caption: `${p.name}, checked against its brief` });
        const more = count('failed') + count('uncertain') ? '\n\nSay "fix it" to send the failed ones to Claude.' : '';
        rt.say?.(`${said}\n\n${lines.join('\n')}${more}`, { kind: null, spoken: said });
      }

      function start(p, c) {
        if (running.has(p.name)) return false;
        running.add(p.name);
        runAll(p, c)
          .catch((err) => rt.say?.(`The check of ${p.name} broke: ${String(err.message || err).slice(0, 160)}`, { kind: null }))
          .finally(() => running.delete(p.name));
        return true;
      }

      // A brief-approved build starts (plugins/orchestrator → code_start_task / code_new_project with
      // the brief in the instruction): its checklist goes into the project, waiting for Claude to finish.
      api.on('after_tool_call', ({ toolName, params = {}, error } = {}) => {
        if (error || (toolName !== 'code_start_task' && toolName !== 'code_new_project')) return;
        const brief = briefFrom(params.instruction);
        if (!brief) return;
        const checks = checksFrom(brief);
        const p = projectOf(params.project || params.name);
        if (!checks.length || !p?.path) return;
        writeChecks(p.path, { project: p.name, at: new Date().toISOString(), pending: true, round: 1, checks });
      });

      // Claude finished on a project waiting for its check (the brief, or "fix it"): check it.
      const seen = new Set();
      rt.tasks?.on?.('task', (task) => {
        if (task?.status !== 'done' || !task.path) return;
        const c = readJson(checksFile(task.path));
        if (!c?.pending || !c.checks?.length) return;
        const key = `${task.id || task.startedAt || ''}:${task.path}`;
        if (seen.has(key)) return;
        seen.add(key);
        start(projectOf(task.project) || { name: task.project || c.project, path: task.path }, c);
      });

      api.registerTool({
        name: 'donecheck_run',
        description: 'Check a coding project\'s website against its brief\'s "Done when" list ("check it", "is it done", "run the checks on X"). Runs in the background.',
        parameters: obj({ project: { type: 'string' } }),
        async execute(_id, { project } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ note: project ? `I don't know a project called ${project}.` : 'Which project should I check?' });
          const c = readJson(checksFile(p.path));
          if (!c?.checks?.length) return reply({ note: `There's no checklist for ${p.name} yet: the checks come from a brief. Say "let's work on ${p.name}" to make one.` });
          if (!start(p, c)) return reply({ note: `I'm already checking ${p.name}.` });
          return reply({ note: `Checking ${p.name} against its brief (${c.checks.length} checks). I'll tell you the result in a minute.` });
        },
      });

      api.registerTool({
        name: 'donecheck_fix',
        description: 'Send only the failed / unsure checks of the last done-check to Claude to fix ("fix it", "fix the failed ones"); Novi checks again after.',
        parameters: obj({ project: { type: 'string' } }),
        async execute(_id, { project } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ note: project ? `I don't know a project called ${project}.` : 'Which project should I fix?' });
          const last = lastRun(p.path);
          if (!last) return reply({ note: `I haven't checked ${p.name} yet. Say "check ${p.name}" first.` });
          const message = fixMessage(last.results || []);
          if (!message) return reply({ note: `Nothing to fix in ${p.name}: every check passed or needs you.` });
          if (p.working) return reply({ note: `Claude is still working on ${p.name}. Say "fix it" when it's done.` });
          const c = readJson(checksFile(p.path)) || {};
          writeChecks(p.path, { ...c, pending: true, round: (c.round || last.round || 1) + 1 });
          await rt.startCoding({ project: p.name, instruction: message });
          const n = (last.results || []).filter((r) => r.state === 'failed' || r.state === 'uncertain').length;
          return reply({ note: `Sent ${n} check${n === 1 ? '' : 's'} to Claude to fix. I'll check again when it's done.` });
        },
      });

      // Asked by the AI (not the user's own words): checking starts the project's site; fixing spends
      // Claude credits — both ask first. "check it" / "fix it" said by the user are the yes (direct).
      api.on('before_tool_call', async ({ toolName, params }) => {
        if (toolName === 'donecheck_fix') {
          const title = `Send the failed checks of ${params?.project || 'the project'} to Claude?`;
          return { requireApproval: { title, prompt: title, description: 'Claude fixes only the checks that failed.', severity: 'warning', category: 'code', grantable: false } };
        }
        if (toolName === 'donecheck_run') {
          const title = `Start ${params?.project || 'the project'}'s site and check it?`;
          return { requireApproval: { title, prompt: title, description: 'Runs it in a hidden browser; nothing is sent to the internet.', severity: 'warning', category: 'preview', grantable: true } };
        }
        return null;
      });
    },
  });
}

export default createDoneCheckPlugin();
