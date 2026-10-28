import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { gitChanges, changeSummary, changeLine, fromTaskFiles } from './changes.js';
import { testCommand, parseTestOutput, testSummary } from './tests.js';

// "See test results and changes on the phone" (Novi Build List, 2026-10-29): what Claude changed and the
// project's own tests, said short and shown in the chat, from anywhere — no AI, no Claude credits.
const reply = (details) => ({ content: [], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// The project's own test command (fixed: "npm test" / "python -m pytest -q"), in its folder, ≤ 5 min.
function runShell(command, cwd, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-200_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { keep('\n(stopped after 5 minutes)'); child.kill(); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, output: `${output}\n${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
  });
}

const baseName = (f) => path.posix.basename(String(f).replace(/\\/g, '/').replace(/\/$/, ''));

export function createChangesPlugin({ git = gitExec, run = runShell } = {}) {
  return definePluginEntry({
    id: 'changes',
    name: 'Changes and tests',
    description: "What Claude changed in a project (git or the files it wrote) and the project's own test results, from anywhere.",
    register(api) {
      const rt = api.runtime || {};
      const projectOf = (name) => rt.codingProject?.(name) || null;
      const execIn = (dir) => (args) => git(args, dir);
      const taskFiles = (dir) => {
        const s = rt.tasks?.status?.() || {};
        const same = s.path && String(s.path).replace(/\\/g, '/').toLowerCase() === String(dir).replace(/\\/g, '/').toLowerCase();
        return same ? fromTaskFiles(s.files, dir) : [];
      };

      api.registerTool({
        name: 'code_changes',
        description: 'What Claude changed in a coding project: the changed files with lines added/removed ("what did Claude change", "show me the changes"), or one file\'s changed lines (file).',
        parameters: obj({ project: { type: 'string' }, file: { type: 'string', description: 'A file name, to see its changed lines' } }),
        async execute(_id, { project, file } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ note: project ? `I don't know a project called ${project}.` : 'Which project?' });
          const exec = execIn(p.path);
          const list = await gitChanges(p.path, { exec });
          if (list === null) {
            const wrote = taskFiles(p.path);
            if (!wrote.length) return reply({ note: `${p.name} has no git, and I don't know which files Claude wrote last.` });
            return reply({ note: `${p.name} has no git, so here are the files Claude wrote last: ${wrote.map((c) => c.file).join(', ')}.` });
          }
          if (file) {
            const want = String(file).toLowerCase();
            const hit = list.find((c) => c.file.toLowerCase() === want || baseName(c.file).toLowerCase() === want || c.file.toLowerCase().endsWith(`/${want}`));
            if (!hit) return reply({ note: `I don't see changes in ${file} since the last commit.` });
            if (hit.isNew) return reply({ note: `${hit.file} is a new file (not in git yet).` });
            const diff = String(await exec(['diff', 'HEAD', '--', hit.file]).catch(() => '')).split('\n').filter((l) => !/^(?:diff --git|index |--- |\+\+\+ )/.test(l));
            const shown = diff.slice(0, 80).join('\n').trim();
            return reply({ note: `Changes in ${hit.file}${diff.length > 80 ? ' (first 80 lines)' : ''}:\n\n\`\`\`diff\n${shown}\n\`\`\`` });
          }
          if (!list.length) return reply({ note: changeSummary(list) });
          const first = baseName(list[0].file);
          return reply({ note: `${changeSummary(list)}\n\n${list.map(changeLine).join('\n')}\n\nSay "show me the changes in ${first}" to see the lines.` });
        },
      });

      const running = new Set();
      api.registerTool({
        name: 'code_tests',
        description: 'Run a coding project\'s own tests on the laptop and say how many passed / failed ("run the tests", "did the tests pass"). Runs in the background.',
        parameters: obj({ project: { type: 'string' } }),
        async execute(_id, { project } = {}) {
          const p = projectOf(project);
          if (!p) return reply({ note: project ? `I don't know a project called ${project}.` : 'Which project?' });
          const command = testCommand(p.path);
          if (!command) return reply({ note: `I don't see any tests in ${p.name} (no test script).` });
          if (running.has(p.name)) return reply({ note: `${p.name}'s tests are already running.` });
          running.add(p.name);
          run(command, p.path)
            .then(({ code, output }) => rt.say?.(testSummary(parseTestOutput(output), code, output), { kind: null }))
            .catch((err) => rt.say?.(`${p.name}'s tests couldn't start: ${String(err.message || err).slice(0, 160)}`, { kind: null }))
            .finally(() => running.delete(p.name));
          return reply({ note: `Running ${p.name}'s tests (${command}). I'll tell you the result.` });
        },
      });

      // Running tests runs the project's code: asked when the AI picks it; the user's own words are the yes.
      api.on('before_tool_call', async ({ toolName, params }) => {
        if (toolName !== 'code_tests') return null;
        const title = `Run ${params?.project || 'the project'}'s tests?`;
        return { requireApproval: { title, prompt: title, description: 'Runs its own test command on the laptop.', severity: 'warning', category: 'commands', grantable: true } };
      });

      // Claude finished: say what changed, so the phone sees it without asking.
      const seen = new Set();
      rt.tasks?.on?.('task', async (task) => {
        if (task?.status !== 'done' || !task.path) return;
        const key = `${task.id || task.startedAt || ''}:${task.path}`;
        if (seen.has(key)) return;
        seen.add(key);
        const list = (await gitChanges(task.path, { exec: execIn(task.path) }).catch(() => null)) ?? taskFiles(task.path);
        if (list.length) rt.say?.(`${changeSummary(list)} Say "show me the changes" or "run the tests".`, { kind: null });
      });
    },
  });
}

export default createChangesPlugin();
