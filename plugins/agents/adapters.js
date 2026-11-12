// The adapters: one per agent, all the same shape. Claude Code and Codex build; the AI websites in Novi's
// hidden Chrome window (plugins/orchestrator/sites.json: ChatGPT, Gemini, Perplexity, DeepSeek…) and the
// free API ("the backup AI") do research, plans and reviews. A new agent = one more entry here or one more
// site in sites.json.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SITES, createSiteDriver } from '../orchestrator/siteDriver.js';

const TEXT = ['research', 'plan', 'review'];
const ok = { ok: true };

export function defaultExec(args, { cwd, input, timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(args[0], args.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).slice(0, 400)), { code: err.code }));
      else resolve(String(stdout));
    });
    if (input != null) { child.stdin?.on('error', () => {}); child.stdin?.end(input); }
  });
}

export function buildAdapters({ rt = {}, exec = defaultExec, sites = SITES, log = () => {} } = {}) {
  const out = [];
  const busy = () => { const s = rt.tasks?.status?.(); return Boolean(s?.active && s.status === 'running'); };

  out.push({
    id: 'claude', name: 'Claude', aliases: ['claude code', 'cloud'], roles: ['build'], order: 1,
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
    id: 'codex', name: 'Codex', aliases: ['openai codex'], roles: ['build'], order: 2,
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
