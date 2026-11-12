// OpenCode as team members (2026-11-12, user: "the easy work is given to it and the hard is done by claude").
// OpenCode (opencode-ai, MIT) is a coding agent that edits files and runs tests like Claude does; the model
// inside it is swappable, so each free model is its own team member with its own track record.
//
// Every run: hidden (`opencode run --pure`), the task package as an attached file (a long package doesn't fit a
// Windows command line), our own settings on top of the user's: edits allowed, shell commands denied except
// the project's tests, no web fetching, every tool server from the user's own OpenCode settings switched off
// (live 2026-11-12: one with hundreds of tools made each request 258k tokens and OpenCode looped for minutes),
// no sharing, no auto-update. Only the shell basics go into its environment; the OpenRouter key only for an
// OpenRouter model. Free models may learn from the code, so a project is used only after the user said yes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testEnv } from './review.js';

const TESTS = ['npm test', 'npm test *', 'npm run test*', 'npx vitest run*', 'npx jest*', 'python -m pytest*', 'pytest*'];

export function userMcpServers(home = os.homedir()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    return Object.keys(cfg.mcp || {});
  } catch { return []; }
}

export function opencodeConfig({ model, env = process.env, userMcp = [] } = {}) {
  const config = {
    permission: { edit: 'allow', webfetch: 'deny', bash: { '*': 'deny', ...Object.fromEntries(TESTS.map((t) => [t, 'allow'])) } },
    share: 'disabled',
    autoupdate: false,
    mcp: Object.fromEntries(userMcp.map((name) => [name, { type: 'local', command: ['cmd.exe'], enabled: false }])),
  };
  // A model OpenCode's own list doesn't know yet can still be named here.
  if (String(model).startsWith('openrouter/')) config.provider = { openrouter: { models: { [String(model).slice('openrouter/'.length)]: {} } } };
  const out = { ...testEnv(env), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  if (String(model).startsWith('openrouter/')) {
    const key = String(env.OPENROUTER_API_KEYS || env.OPENROUTER_API_KEY || '').split(',')[0].trim();
    if (key) out.OPENROUTER_API_KEY = key;
  }
  return { env: out, config };
}

// The final words of the run, from OpenCode's JSON events (text parts in order; the last message wins).
export function lastText(jsonl) {
  const texts = [];
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); const t = e?.part?.text ?? (e?.type === 'text' ? e.text : null); if (e?.type === 'text' && t) texts.push(t); } catch { /* not JSON */ }
  }
  return texts.slice(-3).join('\n\n').trim();
}
export function errorOf(jsonl) {
  for (const line of String(jsonl || '').split('\n')) {
    try { const e = JSON.parse(line); if (e?.type === 'error') return String(e.error?.data?.message || e.error?.name || 'OpenCode error').slice(0, 200); } catch { /* not JSON */ }
  }
  return null;
}

// spec: { id, name, model, levels }. deps: exec (args, { cwd, env, timeoutMs }) → stdout; consent(project) → true/false.
export function opencodeAdapter(spec, { exec, consent, home } = {}) {
  let seen = null; // { at, ok }
  const installed = async () => {
    if (seen && Date.now() - seen.at < 10 * 60_000) return seen.ok;
    let ok = false;
    try { await exec(['opencode', '--version'], { timeoutMs: 20_000 }); ok = true; } catch { ok = false; }
    seen = { at: Date.now(), ok };
    return ok;
  };
  return {
    id: spec.id, name: spec.name, aliases: spec.aliases || [], roles: ['build'], levels: spec.levels, order: 30, trains: true,
    async available(ctx = {}) {
      if (!(await installed())) return { ok: false, why: 'OpenCode is not installed' };
      if (ctx.project && consent && (await consent(ctx.project)) === false) return { ok: false, why: `you said no free models on ${ctx.project}` };
      return { ok: true };
    },
    async run(pkg, { ps, task }) {
      const dir = path.dirname(ps.dir); // ps.dir = <project>/.novi
      const brief = path.join(ps.dir, 'outputs', `${task?.id || 'task'}.task.md`);
      fs.mkdirSync(path.dirname(brief), { recursive: true });
      fs.writeFileSync(brief, pkg);
      const { env } = opencodeConfig({ model: spec.model, userMcp: userMcpServers(home) });
      let out = '';
      try {
        // The words before -f: -f takes everything after it as more files (live 2026-11-12).
        out = await exec(['opencode', 'run', '--pure', '-m', spec.model, '--format', 'json', 'Do the task in the attached file. Work only in this project folder. End with the report it asks for.', '-f', brief], { cwd: dir, env, timeoutMs: 20 * 60_000 });
      } catch (err) {
        return { ok: false, error: errorOf(err.stdout) || String(err.message || err).slice(0, 200) };
      }
      const failed = errorOf(out);
      if (failed) return { ok: false, error: failed };
      const text = lastText(out);
      return text ? { ok: true, output: text } : { ok: false, error: `${spec.name} finished without saying what it did` };
    },
  };
}
