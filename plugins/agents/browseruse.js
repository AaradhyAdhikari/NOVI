// browser-use as a team member (2026-11-18, user: the light web worker now; OpenMausBot sandboxes later).
// browser-use (MIT, Python) drives a real browser with an AI model: it opens pages, clicks, types and reads
// to answer a research step from the live web.
//
// Pinned to the 0.13 line on purpose: browser-use 1.0 has the model write Python that runs on the machine
// ("not a sandbox", its own docs), so a web page could talk it into reading any file. 0.13 only has fixed
// browser actions (open, click, type, scroll, read the page, JavaScript inside the page). 1.0 belongs in a
// sandbox (OpenMausBot) later.
//
// Every run: a hidden helper started only for the task (`browseruse_run.py` in its own Python, data/agents/
// browser-use/venv), stopped after a time limit (whole process tree, its browser too), in a fresh folder with
// a throwaway browser profile (Edge, never your Chrome profile, no logins) that is deleted afterwards. Only
// Novi's free Gemini key (Flash, then Flash-Lite), never Claude; no telemetry; the task goes in on stdin.
// Asked once per project before first use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { testEnv } from './review.js';

export const BROWSER_USE_VERSION = '0.13.9';
export const BROWSER_USE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browseruse_run.py');
const LIMIT_MS = 10 * 60_000;
const MAX_STEPS = 25;

// Its own Python (made by scripts/install-browser-use.mjs), else not installed.
export function findBrowserUse(dataDir) {
  if (!dataDir) return null;
  const win = process.platform === 'win32';
  const py = path.join(dataDir, 'agents', 'browser-use', 'venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
  return fs.existsSync(py) ? py : null;
}

// Edge first (Chrome's own profile must never be touched; Edge with a fresh profile is a separate browser).
export function findBrowser(env = process.env) {
  const list = [
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return list.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const first = (v) => String(v || '').split(',')[0].trim();
// Gemini only (live 2026-11-18): browser-use's instructions alone are over the free 8k tokens a minute of
// Groq and GitHub Models ("413 Request too large"), and once it falls back it never goes back. So the main
// model is Gemini Flash and the fallback is Gemini Flash-Lite (same key, its own quota) for a busy moment
// (503 "high demand" seen live).
const PROVIDERS = [
  { provider: 'gemini', model: 'gemini-flash-latest', keys: ['GEMINI_API_KEYS', 'GEMINI_API_KEY'] },
  { provider: 'gemini', model: 'gemini-flash-lite-latest', keys: ['GEMINI_API_KEYS', 'GEMINI_API_KEY'] },
];
// Every free key Novi has, so none can show in a message from it (scrubKeys).
const ALL_KEYS = ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'GROQ_API_KEYS', 'GROQ_API_KEY', 'GITHUBMODELS_API_KEYS', 'GITHUBMODELS_API_KEY', 'OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY'];
const keyOf = (p, env) => p.keys.map((k) => first(env[k])).find(Boolean) || '';

// The models it may use, in order; only providers with a key. Never Claude, never a paid key.
// At most two: the main model and its fallback (only their keys go to the helper; security review).
export function browserUseModels(env = process.env) {
  return PROVIDERS.filter((p) => keyOf(p, env)).slice(0, 2).map(({ provider, model }) => ({ provider, model }));
}

// Only the shell basics (testEnv) + one key per free provider + switches that keep it quiet and local.
export function browserUseEnv(env = process.env, { work } = {}) {
  const out = {
    ...testEnv(env),
    ANONYMIZED_TELEMETRY: 'false',
    BROWSER_USE_CLOUD_SYNC: 'false',
    BROWSER_USE_DISABLE_EXTENSIONS: '1', // no ad-blocker downloads from the web at start
    BROWSER_USE_LOGGING_LEVEL: 'warning',
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
  if (work) out.BROWSER_USE_CONFIG_DIR = path.join(work, 'config');
  const used = new Set(browserUseModels(env).map((m) => m.provider));
  for (const p of PROVIDERS) { const k = keyOf(p, env); if (k && used.has(p.provider)) out[`NOVI_BU_KEY_${p.provider.toUpperCase()}`] = k; }
  return out;
}

// No key ever reaches a card or the chat: every key value that could be in a message becomes ***.
export function scrubKeys(text, env = process.env) {
  let s = String(text || '');
  for (const name of ALL_KEYS) for (const k of String(env[name] || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 3)) s = s.split(k).join('***');
  return s;
}

// Each run folder is named novi-bu-<task>-<8 hex>; its Edge carries that name in its command line, so it is
// found and ended by it (the Python tree kill can miss an Edge that outlived Python). The user's own Edge
// never has that name.
const RUN_NAME = /^novi-bu-[\w-]+-[a-f0-9]{8}$/;
export function killRunEdgesScript(mark) {
  if (!RUN_NAME.test(String(mark))) throw new Error('not a browser-use run folder');
  return `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${mark}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`;
}
export function killRunEdges(mark) {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = killRunEdgesScript(mark);
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, () => resolve()));
}
// Run folders left by a crash or a Novi restart (over an hour old) are deleted.
export function sweepRuns(root, maxAgeMs = 3600_000) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) {
    if (!n.startsWith('novi-bu-')) continue;
    const p = path.join(root, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true }); } catch { /* still in use: next time */ }
  }
}

// The helper prints one line "NOVI_RESULT {json}" at the end; everything else is its log.
export function resultOf(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.startsWith('NOVI_RESULT '));
  if (!lines.length) return null;
  try { return JSON.parse(lines.at(-1).slice('NOVI_RESULT '.length)); } catch { return null; }
}

const short = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// deps: exec (args, { cwd, env, input, timeoutMs, shell, signal }) → stdout; consent(project) → true/false;
// python: its own python.exe (null = not installed); workRoot: where run folders go; env: where keys come from.
export function browserUseAdapter({ exec, consent = null, python = null, workRoot = null, env = process.env, browserPath = findBrowser(), timeoutMs = LIMIT_MS, script = BROWSER_USE_SCRIPT, killEdges = killRunEdges } = {}) {
  let swept = false;
  const say = (t) => short(scrubKeys(t, env));
  return {
    id: 'browser-use', name: 'browser-use', aliases: ['browser use', 'browseruse', 'web agent', 'web worker'], roles: ['research'],
    order: 40, // after the AI websites (they need no extra install); before learned members and the backup AI
    async available(ctx = {}) {
      if (!python) return { ok: false, why: 'browser-use is not installed (run node scripts/install-browser-use.mjs)' };
      if (!browserUseModels(env).length) return { ok: false, why: 'browser-use needs a Gemini key (Groq and GitHub Models are too small for it on the free plans)' };
      if (!browserPath) return { ok: false, why: 'browser-use needs Edge or Chrome installed' };
      // Never on a project without the once-per-project question (no way to ask = not used there).
      if (ctx.project && !consent) return { ok: false, why: `browser-use can't ask about ${ctx.project} yet` };
      if (ctx.project) {
        const yes = await consent(ctx.project);
        if (yes === false) return { ok: false, why: `you said no to browser-use on ${ctx.project}` };
        if (yes !== true) return { ok: false, why: `browser-use on ${ctx.project}: the question was not answered` };
      }
      return { ok: true };
    },
    async run(pkg, { task, signal = null } = {}) {
      const root = workRoot || path.join(process.cwd(), 'data', 'agents', 'browser-use', 'runs');
      if (!swept) { swept = true; sweepRuns(root); }
      const mark = `novi-bu-${String(task?.id || 'task').replace(/[^\w-]/g, '').slice(0, 40) || 'task'}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const work = path.join(root, mark);
      fs.mkdirSync(work, { recursive: true });
      try {
        const job = { task: pkg, work, browserPath, models: browserUseModels(env), maxSteps: MAX_STEPS, timeoutSec: Math.max(30, Math.floor(timeoutMs / 1000) - 30) };
        let out;
        try {
          // -I: isolated Python (no PYTHON* settings, no user packages, the script's folder not importable).
          out = await exec([python, '-I', script], { cwd: work, env: browserUseEnv(env, { work }), input: JSON.stringify(job), timeoutMs, shell: false, signal });
        } catch (err) {
          // The helper's own one-line reason first; raw stderr only when there is none. Keys scrubbed either way.
          const r = resultOf(err.stdout);
          return { ok: false, error: `browser-use: ${say(r?.error || err.message)}` };
        }
        const r = resultOf(out);
        if (!r) return { ok: false, error: 'browser-use finished without an answer' };
        if (!r.ok) return { ok: false, error: `browser-use: ${say(r.error || 'it gave up')}` };
        const answer = String(r.output || '').trim();
        if (!answer) return { ok: false, error: 'browser-use finished without an answer' };
        const urls = [...new Set((r.urls || []).filter((u) => /^https?:\/\//i.test(String(u))))].slice(0, 10);
        const full = scrubKeys(urls.length ? `${answer}\n\nPages it read:\n${urls.map((u) => `- ${u}`).join('\n')}` : answer, env);
        return { ok: true, output: full, summary: short(scrubKeys(answer, env), 160) };
      } finally {
        try { await killEdges(mark); } catch { /* nothing left to end */ }
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      }
    },
  };
}
