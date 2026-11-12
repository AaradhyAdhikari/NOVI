// The adapters: one per agent, all the same shape. Claude Code and Codex build; the AI websites in Novi's
// hidden Chrome window (plugins/orchestrator/sites.json: ChatGPT, Gemini, Perplexity, DeepSeek…) and the
// free API ("the backup AI") do research, plans and reviews. A new agent = one more entry here or one more
// site in sites.json.
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { opencodeAdapter, findOpencode } from './opencode.js';
import { SITES, createSiteDriver } from '../orchestrator/siteDriver.js';

const TEXT = ['research', 'plan', 'review'];
const ok = { ok: true };

// Windows runs .cmd programs through a shell, which splits arguments at spaces ("C:\dev\Team test\…" became
// "C:\dev\Team", live 2026-11-12): quote any argument with a space or shell character.
export const shellArgs = (args, win = process.platform === 'win32') => (win ? args.map((a, i) => (i > 0 && /[\s&|<>^()"%!]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a))) : args);
export const plainError = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '').trim(); // eslint-disable-line no-control-regex

// Runs a program and gives back what it printed. env: only what's passed (callers build a minimal one).
// On a timeout the whole process tree is ended (a shell's child would otherwise keep running on Windows).
// shell: false for a program given by its full path (no shell, no quoting needed); default: a shell on Windows.
export function defaultExec(args, { cwd, input, env, timeoutMs = 20 * 60_000, shell = process.platform === 'win32' } = {}) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const [cmd, ...rest] = shell ? shellArgs(args, win) : args;
    // No input → stdin closed: OpenCode waits for piped text on an open stdin and never starts (live 2026-11-12).
    const child = spawn(cmd, rest, { cwd, env: env || process.env, windowsHide: true, shell, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const end = (err) => { if (done) return; done = true; clearTimeout(timer); if (err) reject(Object.assign(err, { stdout })); else resolve(stdout); };
    const timer = setTimeout(() => {
      if (win && child.pid) execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
      else child.kill('SIGKILL');
      end(new Error(`${args[0]} took longer than ${Math.round(timeoutMs / 60000)} min and was stopped`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d; if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000); });
    child.stderr?.on('data', (d) => { stderr += d; if (stderr.length > 100_000) stderr = stderr.slice(-50_000); });
    child.on('error', (err) => end(err));
    child.on('close', (code) => (code === 0 ? end(null) : end(new Error(plainError(stderr || `${args[0]} exited with ${code}`).slice(0, 400)))));
    if (input != null) { child.stdin?.on('error', () => {}); child.stdin?.end(input); }
  });
}

// consent(project): free models may see this project (asked once, remembered). levels: how early each coder
// comes per difficulty (lower = earlier); the track record moves them.
export function buildAdapters({ rt = {}, exec = defaultExec, sites = SITES, log = () => {}, consent = null } = {}) {
  const out = [];
  const busy = () => { const s = rt.tasks?.status?.(); return Boolean(s?.active && s.status === 'running'); };

  out.push({
    id: 'claude', name: 'Claude', aliases: ['claude code', 'cloud'], roles: ['build'], order: 1, levels: { easy: 90, medium: 20, hard: 10 },
    available: async () => (!rt.startCoding ? { ok: false, why: 'Claude Code is not set up' } : busy() ? { ok: false, why: 'Claude is already working on a task' } : ok),
    // A package carrying other AIs' answers (untrusted) gets Claude's plan card first, so nothing from a
    // website turns into edits without the user's yes (code review 2026-11-11).
    async run(pkg, { project, untrusted = false }) {
      const r = await rt.startCoding({ project, instruction: pkg, planFirst: Boolean(untrusted) });
      if (r?.error) return { ok: false, error: r.error };
      return { ok: true, pending: true, runId: rt.tasks?.status?.()?.id || null };
    },
  });

  let codexSeen = null; // { at, ok }
  out.push({
    id: 'codex', name: 'Codex', aliases: ['openai codex'], roles: ['build'], order: 2, levels: { medium: 25, hard: 15 },
    available: async () => {
      if (codexSeen && Date.now() - codexSeen.at < 10 * 60_000) return codexSeen.ok ? ok : { ok: false, why: 'Codex is not installed' };
      let yes = false;
      try { await exec(['codex', '--version'], { timeoutMs: 10_000 }); yes = true; } catch { yes = false; }
      codexSeen = { at: Date.now(), ok: yes };
      return yes ? ok : { ok: false, why: 'Codex is not installed' };
    },
    async run(pkg, { ps }) {
      // Not live-tested (no Codex on this laptop yet): `codex exec` reads the task from stdin and works in the project folder.
      const text = await exec(['codex', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-'], { cwd: path.dirname(ps.dir), input: pkg }); // ps.dir = <project>/.novi
      return { ok: true, output: text.trim().slice(-6000), summary: text.trim().split('\n').filter(Boolean).at(-1) };
    },
  });

  const opencodeProgram = findOpencode();
  // Novi's own small coder (free, Groq): easy edits.
  out.push({
    id: 'novi-coder', name: 'Novi Coder', aliases: ['novi coder', 'own coder'], roles: ['build'], order: 4, levels: { easy: 30 },
    available: async () => (!rt.startCoding ? { ok: false, why: 'Novi Coder is not set up' } : busy() ? { ok: false, why: 'a coding task is already running' } : ok),
    async run(pkg, { project }) {
      const r = await rt.startCoding({ project, instruction: pkg, agent: 'novi-coder' });
      if (r?.error) return { ok: false, error: r.error };
      return { ok: true, pending: true, runId: rt.tasks?.status?.()?.id || null };
    },
  });

  // OpenCode with free models (live 2026-11-12: DeepSeek V4.1 Flash did a task in 19 s). Free Kimi ended on
  // OpenRouter that day (paid only); a model that comes back free is one more line here.
  for (const spec of [
    { id: 'opencode-deepseek', name: 'OpenCode (DeepSeek)', aliases: ['deepseek', 'opencode deepseek'], model: 'opencode/deepseek-v4.1-flash-free', levels: { easy: 10, medium: 40 } },
    { id: 'opencode-glm', name: 'OpenCode (GLM)', aliases: ['glm', 'opencode glm'], model: 'opencode/glm-5.3-flash-free', levels: { easy: 15, medium: 45 } },
    { id: 'opencode-pickle', name: 'OpenCode (Big Pickle)', aliases: ['big pickle', 'opencode'], model: 'opencode/big-pickle', levels: { easy: 20, medium: 50 } },
  ]) out.push(opencodeAdapter(spec, { exec, consent, program: opencodeProgram }));

  let driver = null;
  const getDriver = () => driver || (rt.browserRequest ? (driver = createSiteDriver({ request: rt.browserRequest, log })) : null);
  let order = 10;
  for (const [key, site] of Object.entries(sites)) {
    out.push({
      id: key, name: site.name, aliases: site.aliases || [], roles: site.roles || TEXT, order: order++,
      available: async () => (rt.browserStatus?.().connected && getDriver() ? ok : { ok: false, why: `${site.name} needs Chrome connected with the Novi extension` }),
      async run(pkg) {
        const r = await getDriver().ask(key, pkg);
        if (r?.error) return { ok: false, error: r.error };
        return { ok: true, output: r.text, partial: Boolean(r.partial) };
      },
    });
  }

  out.push({
    id: 'backup', name: 'the backup AI', aliases: ['backup', 'backup ai', 'free ai', 'api'], roles: TEXT, order: 99,
    available: async () => (rt.complete ? ok : { ok: false, why: 'no free AI key is set' }),
    async run(pkg) {
      const text = await rt.complete(pkg);
      return text ? { ok: true, output: text } : { ok: false, error: 'the backup AI gave no answer' };
    },
  });
  return out;
}
