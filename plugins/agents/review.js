// The review gate (multi-agent orchestrator, Phase 4, 2026-11-12). User: "every AI is answerable to Novi…
// the AIs report to Novi and Novi then reports to me". Every finished task comes back in one shape (files,
// tests, risks, questions), Novi checks the work itself (tests run, no private file touched, a full answer),
// and one card asks the user: approve, or send it back with what to change.
import { execFile, spawn } from 'node:child_process';
import { isPrivateFile } from '../commit/work.js';
import { gitChanges } from '../changes/changes.js';
import { testCommand, parseTestOutput, testSummary } from '../changes/tests.js';

const HEADS = { files: /^files?(?: changed| touched)?$/i, tests: /^tests?(?: run)?$/i, risks: /^risks?$/i, questions: /^(?:open )?questions?$/i };
const clean = (l) => String(l || '').replace(/^[\s>#*_-]+|[\s*_]+$/g, '').replace(/^\d+[.)]\s*/, '').trim();
const NONE = /^(?:none|nothing|n\/a|na|-|no(?:ne)? (?:files|tests|risks|questions)?)\.?$/i;

// The report part of an answer: "Files changed: …", "## Risks", "**Questions:**", list or same line.
export function parseReport(text) {
  const out = { files: [], tests: '', risks: [], questions: [], has: false };
  let at = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    const m = /^([A-Za-z ]{3,20}?)\s*:\s*(.*)$/.exec(line) || [null, line, ''];
    const head = Object.keys(HEADS).find((k) => HEADS[k].test(m[1].trim()));
    if (head) {
      at = head;
      out.has = true;
      const rest = clean(m[2]);
      // "Risks: none" is no entry; "Files changed: a.js, b.js" is two (code review 2026-11-12).
      if (rest && !NONE.test(rest)) {
        if (head === 'tests') out.tests = rest;
        else out[head].push(...(head === 'files' ? rest.split(/\s*,\s*/) : [rest]).map(clean).filter(Boolean));
      }
      continue;
    }
    if (!at) continue;
    if (!/^\s*(?:[-*•]|\d+[.)])\s+/.test(raw) && at !== 'tests') { at = null; continue; }
    if (NONE.test(line)) continue;
    if (at === 'tests') { if (!out.tests) out.tests = line; } else out[at].push(line);
  }
  return out;
}

// The project's own tests run with only what a shell needs: never Novi's keys (that code was just written by
// an agent and runs before the user's yes; code review 2026-11-12).
const KEEP = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|USERNAME|NODE_ENV)$/i;
export const testEnv = (env = process.env) => ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => KEEP.test(k))), FORCE_COLOR: '0', CI: '1' });
// Passed only when the run exited cleanly and no test failed (a suite that won't load exits 1 with "10 passed").
export const testsOk = (result, code) => code === 0 && !(result && result.failed);
const LIMIT = 200_000;
const run = (cmd, dir) => new Promise((resolve) => {
  const child = spawn(cmd, { cwd: dir, shell: true, windowsHide: true, env: testEnv() });
  let output = '';
  let done = false;
  const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, output: output.slice(-20_000) }); };
  // Windows: kill the whole tree (npm → node), else the pipes stay open and 'close' never comes.
  const timer = setTimeout(() => {
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
    else child.kill('SIGKILL');
    output += '\n(stopped after 5 minutes)';
    finish(124);
  }, 5 * 60_000);
  const add = (d) => { output += d; if (output.length > LIMIT) output = output.slice(-LIMIT / 2); };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  child.on('close', (code) => finish(code));
  child.on('error', () => finish(-1));
});
export async function defaultRunTests(dir) {
  const cmd = testCommand(dir);
  if (!cmd) return { ran: false, ok: true, summary: 'No tests in this project.' };
  const { code, output } = await run(cmd, dir);
  const result = parseTestOutput(output);
  const ok = testsOk(result, code);
  return { ran: true, ok, summary: ok || !result || result.failed ? testSummary(result, code, output) : `The tests reported ${result.passed} passed, but the run failed (exit code ${code}).` };
}
export const defaultChanges = (dir) => gitChanges(dir, { exec: (args) => new Promise((resolve, reject) => execFile('git', args, { cwd: dir, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(String(out))))) });

// What Novi found. build: the files that changed (never a private one) and the tests; text: a full answer.
export async function checkTask({ task, dir, output = '', changes = defaultChanges, runTests = defaultRunTests }) {
  const report = parseReport(output);
  const problems = [];
  let files = report.files;
  let tests = report.tests ? { ran: true, ok: !/\b[1-9]\d* failed/i.test(report.tests), summary: report.tests } : null;
  if (task.role === 'build') {
    const list = (await changes(dir).catch(() => null)) || [];
    files = list.map((c) => c.file).filter((f) => !/^\.novi(?:[\\/]|$)/.test(String(f))); // Novi's own record isn't the agent's work
    const bad = files.filter(isPrivateFile);
    if (bad.length) problems.push(`It changed private files: ${bad.join(', ')}.`);
    tests = await runTests(dir).catch((err) => ({ ran: false, ok: false, summary: `The tests didn't run: ${err.message}` }));
    if (!tests.ok) problems.push(`Tests: ${tests.summary}`);
  } else {
    // Files and tests are only for building: a research/plan answer's own "Files changed"/"Tests" lines are not shown (live 2026-11-12).
    files = [];
    tests = null;
    if (!String(output).trim()) problems.push('The answer came back empty.');
    if (/^partial/i.test(task.note || '')) problems.push('The answer is partial: the site stopped before it finished.');
  }
  return { ok: !problems.length, problems, files, tests, risks: report.risks, questions: report.questions };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// The card: who did what, what Novi found (problems first), approve or send back ("change X").
export function reviewCard({ project, task, agentName, check, output = '' }) {
  const found = [
    check.files?.length ? `${plural(check.files.length, 'file')} changed` : '',
    check.tests?.ran ? check.tests.summary.replace(/\.$/, '') : '',
  ].filter(Boolean).join(', ');
  const lead = `${agentName} finished ${task.id} for ${project}`;
  const prompt = check.ok
    ? `${lead}${found ? `: ${found}` : ''}. Approve?`
    : `${lead}, but ${check.problems[0].replace(/\.$/, '')}. Approve anyway, or send it back?`;
  const detail = [
    ...(check.problems.length ? ['Problems:', ...check.problems.map((p) => `- ${p}`), ''] : []),
    ...(check.files?.length ? ['Files:', ...check.files.slice(0, 20).map((f) => `- ${f}`), ''] : []),
    ...(check.tests?.ran ? [`Tests: ${check.tests.summary}`, ''] : []),
    ...(check.risks?.length ? ['Risks:', ...check.risks.map((r) => `- ${r}`), ''] : []),
    ...(check.questions?.length ? ['Questions:', ...check.questions.map((q) => `- ${q}`), ''] : []),
    ...(output ? ['Answer:', String(output).slice(0, 3000)] : []),
    'Say "approve", or "change …" to send it back with what to fix.',
  ].join('\n');
  return { title: `${project} · ${task.id}: ${task.title} (${agentName})`, prompt, detail, changeable: true, timeoutMs: null, source: 'agents', speaksOnDeny: true };
}
