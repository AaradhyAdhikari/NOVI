import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { browserUseAdapter, browserUseEnv, browserUseModels, resultOf, findBrowserUse, BROWSER_USE_SCRIPT } from '../../plugins/agents/browseruse.js';
import { createConsent } from '../../plugins/agents/consent.js';
import { createRegistry } from '../../plugins/agents/registry.js';

// browser-use as a team member (2026-11-18, user picked it as the light web worker): a hidden helper started
// only for a task, on Novi's free keys, in its own throwaway browser profile, stopped after a time limit.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-bu-'));
const KEYS = { GROQ_API_KEYS: 'gk1,gk2', GEMINI_API_KEYS: 'gm1', GITHUBMODELS_API_KEYS: 'gh1', ANTHROPIC_API_KEY: 'claude-secret', OPENAI_API_KEY: 'oa-secret', CLAUDE_CODE_OAUTH_TOKEN: 'cc', BROWSER_USE_API_KEY: 'bu-cloud', PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' };

describe('browser-use: keys and settings', () => {
  it('only Novi\'s free Gemini key, the first one; never Claude, OpenAI or a browser-use cloud key', () => {
    const env = browserUseEnv(KEYS, { work: 'C:\\w' });
    expect(env.NOVI_BU_KEY_GEMINI).toBe('gm1');
    expect(env.NOVI_BU_KEY_GROQ).toBeUndefined();
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'BROWSER_USE_API_KEY', 'GROQ_API_KEYS']) expect(env[k]).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/claude-secret|oa-secret|bu-cloud/);
  });
  it('no telemetry, no cloud sync, no downloaded extensions, its settings inside the run folder', () => {
    const env = browserUseEnv(KEYS, { work: 'C:\\w' });
    expect(env.ANONYMIZED_TELEMETRY).toBe('false');
    expect(env.BROWSER_USE_CLOUD_SYNC).toBe('false');
    expect(env.BROWSER_USE_DISABLE_EXTENSIONS).toBe('1');
    expect(env.BROWSER_USE_CONFIG_DIR).toBe(path.join('C:\\w', 'config'));
    expect(env.PYTHONNOUSERSITE).toBe('1');
  });
  it('Gemini Flash, then Flash-Lite on the same key; Groq and GitHub Models are too small for it (live)', () => {
    expect(browserUseModels(KEYS).map((m) => m.model)).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest']);
    expect(browserUseModels({ GROQ_API_KEYS: 'g', GITHUBMODELS_API_KEYS: 'h' })).toEqual([]);
    expect(browserUseModels({ ANTHROPIC_API_KEY: 'x' })).toEqual([]);
  });
  it('reads the helper\'s last result line, ignores its log lines', () => {
    expect(resultOf('INFO start\nNOVI_RESULT {"ok":true,"output":"hi"}\nbye')).toEqual({ ok: true, output: 'hi' });
    expect(resultOf('nothing here')).toBeNull();
    expect(resultOf('NOVI_RESULT {broken')).toBeNull();
  });
  it('installed = its own Python in Novi\'s data folder', () => {
    const dir = tmp();
    expect(findBrowserUse(dir)).toBeNull();
    const py = path.join(dir, 'agents', 'browser-use', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, '');
    expect(findBrowserUse(dir)).toBe(py);
  });
});

describe('browser-use: the helper script', () => {
  const text = fs.readFileSync(BROWSER_USE_SCRIPT, 'utf8');
  it('pins the safe 0.13 line: fixed browser actions, no file tools, no uploads, its own fresh profile, no localhost or raw IPs', () => {
    expect(text).toMatch(/exclude_actions=\[[^\]]*'upload_file'[^\]]*'read_file'[^\]]*'write_file'[^\]]*'replace_file'/s);
    expect(text).toMatch(/available_file_paths=\[\]/);
    expect(text).toMatch(/user_data_dir=/);
    expect(text).toMatch(/block_ip_addresses=True/);
    expect(text).toMatch(/'localhost'/);
    expect(text).toMatch(/'\*\.ts\.net'/);
    expect(text).toMatch(/accept_downloads=False/);
    expect(text).toMatch(/enable_default_extensions=False/);
    expect(text).toMatch(/headless=True/);
    expect(text).not.toMatch(/ChatAnthropic|ChatBrowserUse|BROWSER_USE_API_KEY/);
  });
  it('is valid Python', () => {
    let py = null;
    for (const c of ['python', 'python3']) { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); py = c; break; } catch { /* next */ } }
    if (!py) return; // no Python here: nothing to check
    execFileSync(py, ['-I', '-c', `import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())`, BROWSER_USE_SCRIPT]);
  });
});

describe('browser-use as a team member', () => {
  const ready = (over = {}) => {
    const root = tmp();
    const calls = [];
    const a = browserUseAdapter({
      python: 'C:\\novi\\py.exe', workRoot: root, env: KEYS, browserPath: 'C:\\Edge\\msedge.exe',
      consent: async () => true, killEdges: async () => {},
      exec: async (args, opts) => { calls.push({ args, opts, existed: fs.existsSync(opts.cwd) }); return 'log\nNOVI_RESULT {"ok":true,"output":"Found 3 tip apps: A, B, C.","urls":["https://a.example","https://b.example"]}\n'; },
      ...over,
    });
    return { a, root, calls };
  };

  it('researches only, comes after the AI websites, can be named', () => {
    const { a } = ready();
    expect(a.roles).toEqual(['research']);
    expect(a.order).toBeGreaterThan(20);
    expect(a.order).toBeLessThan(60);
    const reg = createRegistry();
    reg.add(a);
    expect(reg.find('browser use')?.id).toBe('browser-use');
    expect(reg.find('browseruse')?.id).toBe('browser-use');
  });

  it('runs its own Python hidden, isolated, no shell, with a time limit and the stop signal; the task goes in on stdin, not the command line', async () => {
    const { a, calls } = ready();
    const signal = new AbortController().signal;
    const r = await a.run('THE PACKAGE: research tip apps', { task: { id: 'T-001' }, project: 'Tip', signal });
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Found 3 tip apps/);
    expect(r.output).toMatch(/https:\/\/a\.example/);
    const { args, opts } = calls[0];
    expect(args[0]).toBe('C:\\novi\\py.exe');
    expect(args[1]).toBe('-I');
    expect(args.join(' ')).not.toMatch(/THE PACKAGE/);
    expect(opts.shell).toBe(false);
    expect(opts.signal).toBe(signal);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(15 * 60_000);
    const job = JSON.parse(opts.input);
    expect(job.task).toMatch(/THE PACKAGE/);
    expect(job.browserPath).toBe('C:\\Edge\\msedge.exe');
    expect(job.models.map((m) => m.model)).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest']);
    expect(JSON.stringify(job)).not.toMatch(/gk1|gm1|gh1/); // keys go by environment only
    expect(opts.env.NOVI_BU_KEY_GEMINI).toBe('gm1');
    expect(calls[0].existed).toBe(true);
  });

  it('its run folder (browser profile, page text) is deleted afterwards, also after a failure', async () => {
    const { a, root } = ready();
    await a.run('x', { task: { id: 'T-1' } });
    expect(fs.readdirSync(root)).toEqual([]);
    const { a: b, root: root2 } = ready({ exec: async () => { throw new Error('boom'); } });
    const r = await b.run('x', { task: { id: 'T-2' } });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(root2)).toEqual([]);
  });

  it('a failure or an empty answer is said plainly', async () => {
    const { a } = ready({ exec: async () => 'NOVI_RESULT {"ok":false,"error":"Groq said 429"}' });
    expect(await a.run('x', { task: { id: 'T' } })).toEqual({ ok: false, error: 'browser-use: Groq said 429' });
    const { a: b } = ready({ exec: async () => 'no result line' });
    expect((await b.run('x', { task: { id: 'T' } })).error).toMatch(/finished without an answer/);
    const { a: c } = ready({ exec: async () => { throw Object.assign(new Error('took longer than 10 min and was stopped'), { stdout: '' }); } });
    expect((await c.run('x', { task: { id: 'T' } })).error).toMatch(/took longer/);
  });

  it('not installed / no free key / no browser / you said no for this project: not available, said plainly', async () => {
    expect(await browserUseAdapter({ python: null, env: KEYS, browserPath: 'x', consent: async () => true }).available()).toEqual({ ok: false, why: expect.stringMatching(/not installed/) });
    expect(await browserUseAdapter({ python: 'p', env: { PATH: 'x' }, browserPath: 'x', consent: async () => true }).available()).toEqual({ ok: false, why: expect.stringMatching(/Gemini key/) });
    expect(await browserUseAdapter({ python: 'p', env: KEYS, browserPath: null, consent: async () => true }).available()).toEqual({ ok: false, why: expect.stringMatching(/Edge or Chrome/) });
    const no = browserUseAdapter({ python: 'p', env: KEYS, browserPath: 'x', consent: async () => false });
    expect(await no.available({ project: 'Tip' })).toEqual({ ok: false, why: expect.stringMatching(/you said no to browser-use on Tip/) });
    expect((await no.available()).ok).toBe(true); // no project asked about yet
    const cannotAsk = browserUseAdapter({ python: 'p', env: KEYS, browserPath: 'x', consent: null });
    expect((await cannotAsk.available({ project: 'Tip' })).ok).toBe(false); // never used on a project without asking
  });
});

describe('asking once per project', () => {
  const setup = (answer) => {
    const file = path.join(tmp(), 'consent.json');
    const asked = [];
    const c = createConsent({ file, find: (n) => ({ name: n, path: `C:\\dev\\${n}` }), ask: async (card) => { asked.push(card); return answer; } });
    return { c, file, asked };
  };
  it('one card per kind and project, remembered (also across restarts)', async () => {
    const { c, file, asked } = setup({ allow: true });
    expect(await c.ask('browser-use', 'Tip')).toBe(true);
    expect(await c.ask('browser-use', 'Tip')).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toMatch(/browser-use.*Tip/);
    expect(asked[0].detail).toMatch(/own hidden browser/);
    const again = createConsent({ file, find: (n) => ({ name: n, path: `C:\\dev\\${n}` }), ask: async () => { throw new Error('must not ask'); } });
    expect(await again.ask('browser-use', 'Tip')).toBe(true);
  });
  it('a yes to free models is not a yes to browser-use (and the free-model answers already saved keep working)', async () => {
    const file = path.join(tmp(), 'consent.json');
    fs.writeFileSync(file, JSON.stringify({ 'c:\\dev\\tip': true }));
    const asked = [];
    const c = createConsent({ file, find: (n) => ({ name: n, path: 'C:\\dev\\tip' }), ask: async (card) => { asked.push(card); return { allow: false }; } });
    expect(await c.ask('free', 'Tip')).toBe(true);
    expect(asked).toHaveLength(0);
    expect(await c.ask('browser-use', 'Tip')).toBe(false);
    expect(asked).toHaveLength(1);
  });
  it('a card not answered asks again next time; two at once share one card', async () => {
    let n = 0;
    const file = path.join(tmp(), 'consent.json');
    const c = createConsent({ file, find: () => null, ask: async () => { n += 1; return { timedOut: true }; } });
    const [x, y] = await Promise.all([c.ask('browser-use', 'Tip'), c.ask('browser-use', 'Tip')]);
    expect([x, y]).toEqual([undefined, undefined]);
    expect(n).toBe(1);
    await c.ask('browser-use', 'Tip');
    expect(n).toBe(2);
  });
});

describe('browser-use security review fixes (2026-11-18)', () => {
  const text = fs.readFileSync(BROWSER_USE_SCRIPT, 'utf8');
  it('no JavaScript action: a page can\'t make it fetch Novi on localhost', () => {
    expect(text).toMatch(/exclude_actions=\[[^\]]*'evaluate'/s);
  });
  it('blocks file/UNC, browser-internal pages and names that point at this laptop; such names never resolve', () => {
    for (const p of ["'file://*'", "'view-source:*'", "'*.nip.io'", "'*.sslip.io'", "'*.localtest.me'"]) expect(text).toContain(p);
    // Never the browser's own start pages: blocking edge:// closed Edge's start tab and it never started (live).
    for (const p of ["'edge://*'", "'chrome://*'", "'about:*'"]) expect(text).not.toContain(p);
    expect(text).toMatch(/COMPUTERNAME/);
    expect(text).toMatch(/--host-resolver-rules=/);
  });
  it('only the key of the models it uses goes to it', () => {
    const env = browserUseEnv(KEYS, { work: 'C:\w' });
    expect(env.NOVI_BU_KEY_GROQ).toBeUndefined();
    expect(env.NOVI_BU_KEY_GEMINI).toBe('gm1');
    expect(env.NOVI_BU_KEY_GITHUBMODELS).toBeUndefined();
    expect(browserUseModels(KEYS)).toHaveLength(2);
  });
  it('a key never shows in an error, and the helper\'s own reason wins over raw stderr', async () => {
    const a = browserUseAdapter({ python: 'p', workRoot: tmp(), env: KEYS, browserPath: 'x', consent: async () => true, killEdges: async () => {}, exec: async () => { throw Object.assign(new Error('stderr: Authorization: Bearer gk1 rejected'), { stdout: '' }); } });
    const r = await a.run('x', { task: { id: 'T' } });
    expect(r.error).not.toMatch(/gk1/);
    const b = browserUseAdapter({ python: 'p', workRoot: tmp(), env: KEYS, browserPath: 'x', consent: async () => true, killEdges: async () => {}, exec: async () => { throw Object.assign(new Error('Traceback gm1'), { stdout: 'NOVI_RESULT {"ok":false,"error":"Gemini key gm1 was refused"}' }); } });
    const r2 = await b.run('x', { task: { id: 'T' } });
    expect(r2.error).toBe('browser-use: Gemini key *** was refused');
  });
  it('its own Edge is ended by its run folder name after every run, and run folders over an hour old are swept', async () => {
    const root = tmp();
    const old = path.join(root, 'novi-bu-T-9-aaaaaaaa');
    fs.mkdirSync(old);
    const past = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(old, past, past);
    const killed = [];
    const a = browserUseAdapter({ python: 'p', workRoot: root, env: KEYS, browserPath: 'x', consent: async () => true, killEdges: async (m) => killed.push(m), exec: async () => 'NOVI_RESULT {"ok":true,"output":"done"}' });
    await a.run('x', { task: { id: 'T-1' } });
    expect(killed).toHaveLength(1);
    expect(killed[0]).toMatch(/^novi-bu-T-1-[a-f0-9]{8}$/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('a card nobody answered is not a no: it says so and asks again next time', async () => {
    const c = createConsent({ file: null, find: () => null, ask: async () => ({ closed: true }) });
    expect(await c.ask('browser-use', 'Tip')).toBeUndefined();
    const a = browserUseAdapter({ python: 'p', env: KEYS, browserPath: 'x', consent: async () => undefined });
    expect(await a.available({ project: 'Tip' })).toEqual({ ok: false, why: expect.stringMatching(/not answered/) });
  });
  it('a no can be taken back', async () => {
    const file = path.join(tmp(), 'consent.json');
    let answer = { allow: false };
    const c = createConsent({ file, find: (n) => ({ name: n, path: `C:\dev\${n}` }), ask: async () => answer });
    expect(await c.ask('browser-use', 'Tip')).toBe(false);
    c.forget('browser-use', 'Tip');
    answer = { allow: true };
    expect(await c.ask('browser-use', 'Tip')).toBe(true);
  });
});

describe('free models need a real yes too', () => {
  it('an unanswered card keeps OpenCode off the project (only true counts)', async () => {
    const { opencodeAdapter } = await import('../../plugins/agents/opencode.js');
    const a = opencodeAdapter({ id: 'opencode-x', name: 'OpenCode', model: 'opencode/x', levels: { easy: 10 } }, { exec: async () => 'v1', consent: async () => undefined });
    expect(await a.available({ project: 'Tip' })).toEqual({ ok: false, why: expect.stringMatching(/not answered/) });
  });
});
