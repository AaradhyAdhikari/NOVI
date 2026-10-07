import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createNovi } from '../../server/app.js';
import { ApprovalQueue } from '../../server/permissions.js';

let server;
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

async function start(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-app-'));
  const config = { dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand: 'claude', coder: 'free' };
  const fakeTasks = Object.assign(new (await import('node:events')).EventEmitter(), {
    status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {},
  });
  const novi = createNovi(config, {
    tasks: fakeTasks,
    agent: { handle: async (text) => `echo: ${text}` },
    router: { status: () => [{ name: 'groq', healthy: true }] },
    transcribe: async (audio, mime) => `heard ${audio.length} bytes of ${mime}`,
    lanUrls: ['https://192.168.1.5:3001'],
    cipher: { protect: async (v) => `enc:${v}`, unprotect: async (v) => v.slice(4) },
    ...overrides,
  });
  server = http.createServer(novi.app);
  novi.attachWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { novi, base, dataDir, ws: base.replace('http', 'ws') + '/ws' };
}

function connect(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  const waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const m = messages.find(pred); if (m) return resolve(m); if (Date.now() - t0 > ms) return reject(new Error(JSON.stringify(messages))); setTimeout(tick, 10); };
    tick();
  });
  return { ws, messages, waitFor, opened: new Promise((r) => ws.on('open', r)) };
}

describe('Novi server', () => {
  it('registers the laptop tools for the brain', async () => {
    const { novi } = await start();
    for (const name of ['open_website', 'youtube_search', 'play_youtube', 'open_app']) expect(novi.tools.get(name)).toBeTruthy();
  });

  it('includes accounts in the snapshot and refuses to connect Gmail without credentials', async () => {
    const { base, ws } = await start();
    const c = connect(ws);
    const snap = await c.waitFor((m) => m.type === 'snapshot');
    expect(snap.accounts).toEqual([]);
    expect(snap.googleConfigured).toBe(false);
    c.ws.close();
    const res = await fetch(`${base}/api/accounts/google/connect`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it('registers the Gmail tools for the brain', async () => {
    const { novi } = await start();
    for (const name of ['gmail_search', 'gmail_read', 'gmail_send', 'gmail_connect', 'accounts_list']) expect(novi.tools.get(name)).toBeTruthy();
  });

  it('renames, sets default and disconnects accounts via the API', async () => {
    const { base, novi } = await start();
    const a = novi.accounts.add({ provider: 'google', email: 'c@college.edu' });
    const patch = await fetch(`${base}/api/accounts/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'College', default: true }) });
    expect(patch.status).toBe(200);
    expect(novi.accounts.get(a.id).label).toBe('college');
    expect(novi.accounts.defaultFor('google').id).toBe(a.id);
    expect((await fetch(`${base}/api/accounts/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/api/accounts/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(novi.accounts.list()).toEqual([]);
  });

  it('serves built-in features as plugins', async () => {
    const { novi } = await start();
    expect(novi.plugins.plugins.map((p) => p.id)).toEqual(['coding', 'laptop', 'accounts']);
    expect(novi.tools).toBe(novi.plugins);
    expect(await novi.tools.get('gmail_send').gate({ to: 'a@b.c', subject: 's', body: 'b' })).toEqual({ block: true, blockReason: 'No Gmail account is connected yet — say "connect my Gmail".', details: { error: 'No Gmail account is connected yet — say "connect my Gmail".', note: 'No Gmail account is connected yet — say "connect my Gmail".' } });
  });

  it('gives plugins account services and disconnects GitHub accounts locally', async () => {
    const { base, novi } = await start();
    expect(novi.plugins.runtime.resolveAccount('github').error).toMatch(/No GitHub account/);
    const a = novi.accounts.add({ provider: 'github', email: 'octo' });
    await novi.plugins.runtime.secrets.set(a.id, 'gho_x');
    expect(await novi.plugins.runtime.secrets.get(a.id)).toBe('gho_x');
    expect((await fetch(`${base}/api/accounts/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(novi.accounts.list()).toEqual([]);
    expect(await novi.plugins.runtime.secrets.get(a.id)).toBeNull();
  });

  it('starts GitHub connection from Settings via the github plugin', async () => {
    const { base, novi } = await start();
    expect((await fetch(`${base}/api/accounts/github/connect`, { method: 'POST' })).status).toBe(404);
    novi.plugins.register({ id: 'github', name: 'GitHub', register(api) { api.registerTool({ name: 'github_connect', description: 'c', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: { user_code: 'AB12-CD34', note: 'Enter AB12-CD34' } }) }); } });
    const res = await fetch(`${base}/api/accounts/github/connect`, { method: 'POST' });
    expect(await res.json()).toEqual({ user_code: 'AB12-CD34', note: 'Enter AB12-CD34' });
  });

  it('speaks an approval prompt and accepts a choice from the screen', async () => {
    const approvals = new ApprovalQueue();
    const { ws } = await start({ approvals });
    const c = connect(ws);
    await c.waitFor((m) => m.type === 'snapshot');
    const decision = approvals.decide({ title: 'Start Novi Coder', tier: 'medium', source: 'novi', prompt: 'Shall I start? Say yes, no, or use Claude instead.', choices: [{ id: 'claude', label: 'Use Claude' }] });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    await c.waitFor((m) => m.type === 'speak' && m.text === 'Shall I start? Say yes, no, or use Claude instead.');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true, choice: 'claude' }));
    await expect(decision).resolves.toEqual({ allow: true, choice: 'claude' });
    c.ws.close();
  });

  it('lets plugins say things in the chat and out loud, and gives them a data folder', async () => {
    const { ws, novi } = await start();
    const c = connect(ws);
    await c.waitFor((m) => m.type === 'snapshot');
    expect(novi.plugins.runtime.dataDir).toBeTruthy();
    novi.plugins.runtime.say('Reminder: call **mom**');
    await c.waitFor((m) => m.type === 'chat' && m.entry.role === 'novi' && m.entry.text === 'Reminder: call **mom**');
    await c.waitFor((m) => m.type === 'speak' && m.text === 'Reminder: call mom');
    c.ws.close();
  });

  it('rejects wrong pairing codes', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'nope' }) });
    expect(res.status).toBe(401);
  });

  it('shows the pairing code and phone URLs to localhost', async () => {
    const { base } = await start();
    const body = await (await fetch(`${base}/api/pairing-code`)).json();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.urls).toEqual(['https://192.168.1.5:3001']);
  });

  it('transcribes raw audio', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus' }, body: Buffer.from('abcd') });
    expect(await res.json()).toEqual({ text: 'heard 4 bytes of audio/webm' });
  });

  it('records voice test samples into data/voice-samples', async () => {
    const { base, dataDir } = await start();
    const before = await (await fetch(`${base}/api/voice-samples`)).json();
    expect(before.phrases.length).toBeGreaterThan(10);
    expect(before.recorded).toEqual([]);
    const id = before.phrases[0].id;
    const res = await fetch(`${base}/api/voice-samples/${id}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('RIFF') });
    expect(res.status).toBe(200);
    const { file } = await res.json();
    expect(fs.existsSync(path.join(dataDir, 'voice-samples', file))).toBe(true);
    expect((await (await fetch(`${base}/api/voice-samples`)).json()).recorded).toEqual([id]);
    const bad = await fetch(`${base}/api/voice-samples/nope`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('RIFF') });
    expect(bad.status).toBe(400);
  });

  it('runs a command heard by the always-on laptop microphone', async () => {
    const { novi } = await start();
    novi.setWakeWord('server');
    await novi.runVoiceCommand(Buffer.from('RIFFabcd'));
    const snap = novi.snapshot();
    expect(snap.wakeWord).toBe('server');
    expect(snap.transcript.map((t) => [t.role, t.text])).toEqual([
      ['user', 'heard 8 bytes of audio/wav'],
      ['novi', 'echo: heard 8 bytes of audio/wav'],
    ]);
  });

  it('speaks through the laptop speakers when no Novi page is open', async () => {
    const spoken = [];
    const { novi } = await start({ localSpeaker: (text) => spoken.push(text) });
    await novi.runVoiceCommand(Buffer.from('RIFF'));
    expect(spoken).toEqual(['echo: heard 4 bytes of audio/wav']);
  });

  it('ignores a voice command that came out empty', async () => {
    const { novi } = await start({ transcribe: async () => '  ' });
    await novi.runVoiceCommand(Buffer.from('RIFF'));
    expect(novi.snapshot().transcript).toEqual([]);
  });

  it('reports health: version, uptime, restarts, recent errors, last backup', async () => {
    const backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-backups-'));
    fs.writeFileSync(path.join(backupsDir, 'novi-data-2026-10-07-0300.zip'), 'x');
    const { base } = await start({
      system: { version: 'abc1234', supervised: true, restarts: 2 },
      logBuffer: { recent: () => [{ at: '2026-10-07T03:00:00.000Z', level: 'warn', text: 'Groq slow' }] },
      backupsDir,
    });
    const h = await (await fetch(`${base}/api/health`)).json();
    expect(h).toMatchObject({ version: 'abc1234', supervised: true, restarts: 2, wakeWord: 'browser' });
    expect(h.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(h.errors).toEqual([{ at: '2026-10-07T03:00:00.000Z', level: 'warn', text: 'Groq slow' }]);
    expect(h.lastBackup).toMatchObject({ file: 'novi-data-2026-10-07-0300.zip' });
    expect(h.providers).toEqual([{ name: 'groq', healthy: true }]);
  });

  it('restarts only when running under the supervisor', async () => {
    const exits = [];
    const plain = await start({ exit: (c) => exits.push(c) });
    const res = await fetch(`${plain.base}/api/restart`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(exits).toEqual([]);
    server.close();
    const supervised = await start({ exit: (c) => exits.push(c), system: { supervised: true } });
    expect((await fetch(`${supervised.base}/api/restart`, { method: 'POST' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect(exits).toEqual([75]);
  });

  it('lists and revokes permission grants, and "always" from a card stores one', async () => {
    const { base, novi } = await start();
    const pending = novi.approvals.decide({ title: 'Open Spotify', tier: 'medium', source: 'novi', category: 'apps', grantable: true });
    const card = novi.approvals.pending()[0];
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'approval', id: card.id, allow: true, always: true }));
    expect((await pending).allow).toBe(true);
    ws.close();
    const list = await (await fetch(`${base}/api/permissions`)).json();
    expect(list.grants.map((g) => g.category)).toEqual(['apps']);
    expect(Array.isArray(list.audit)).toBe(true);
    expect((await fetch(`${base}/api/permissions/apps`, { method: 'DELETE' })).status).toBe(200);
    expect((await (await fetch(`${base}/api/permissions`)).json()).grants).toEqual([]);
  });

  it('lets plugins call other plugins read-only tools, never ones that need approval', async () => {
    const { novi } = await start();
    novi.plugins.register({ id: 'demo', name: 'Demo', register(api) {
      api.registerTool({ name: 'demo_read', execute: async (_id, p) => ({ content: [{ type: 'text', text: `read ${p.x}` }], details: { ok: true } }) });
      api.registerTool({ name: 'demo_send', execute: async () => ({ content: [{ type: 'text', text: 'sent' }] }) });
      api.on('before_tool_call', ({ toolName }) => (toolName === 'demo_send' ? { requireApproval: { title: 'Send', severity: 'warning' } } : undefined));
    } });
    const call = novi.plugins.runtime.callTool;
    expect(await call('demo_read', { x: 1 })).toEqual({ ok: true, text: 'read 1' });
    await expect(call('demo_send', {})).rejects.toThrow(/needs approval/);
    await expect(call('nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('turns text into natural speech (MP3) for the browser, or says why not', async () => {
    const ok = await start({ tts: async (text) => Buffer.from(`MP3:${text}`) });
    const res = await fetch(`${ok.base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Good morning' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('MP3:Good morning');
    server.close();
    const bad = await start({ tts: async () => { throw new Error('blocked'); } });
    const r2 = await fetch(`${bad.base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    expect(r2.status).toBe(502);
  });

  it('serves the voice-detection model and runtime files to the browser', async () => {
    const { base } = await start();
    for (const file of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
      const res = await fetch(`${base}/vad/${file}`);
      expect(res.status, file).toBe(200);
    }
    for (const bad of ['package.json', '..%2Fpackage.json', '..%5C..%5C.env']) expect((await fetch(`${base}/vad/${bad}`)).status, bad).toBe(404);
  });

  it('rejects WebSocket connections from other websites (cross-site WebSocket hijacking)', async () => {
    const { ws } = await start();
    const evil = new WebSocket(ws, { headers: { Origin: 'https://evil.example' } });
    const got = [];
    evil.on('message', (d) => got.push(JSON.parse(d)));
    const code = await new Promise((resolve) => evil.on('close', (c) => resolve(c)));
    expect(code).toBe(4003);
    expect(got).toEqual([]);
  });

  it('accepts its own page origin and non-browser local clients', async () => {
    const { ws, novi } = await start();
    const page = connect(ws.replace('ws://', 'ws://'));
    await page.waitFor((m) => m.type === 'snapshot');
    page.ws.close();
    const own = new WebSocket(ws, { headers: { Origin: 'https://192.168.1.5:3001' } });
    await new Promise((resolve) => own.on('message', resolve));
    own.close();
    expect(novi).toBeTruthy();
  });

  it('rejects API calls from other websites', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'audio/webm' }, body: Buffer.from('a') });
    expect(res.status).toBe(403);
  });

  it('speaks replies without markdown but keeps them in the transcript', async () => {
    const { ws } = await start({ agent: { handle: async () => 'Created **math.js**.' } });
    const c = connect(ws);
    await c.waitFor((m) => m.type === 'snapshot');
    c.ws.send(JSON.stringify({ type: 'user_message', text: 'go' }));
    await c.waitFor((m) => m.type === 'chat' && m.entry.text === 'Created **math.js**.');
    await c.waitFor((m) => m.type === 'speak' && m.text === 'Created math.js.');
    c.ws.close();
  });

  it('sends a snapshot with pending approvals on connect, and answers user messages', async () => {
    const approvals = new ApprovalQueue();
    const { ws } = await start({ approvals });
    approvals.request({ title: 'Claude wants to run: npm i', tier: 'medium', source: 'claude' });
    const c = connect(ws);
    const snap = await c.waitFor((m) => m.type === 'snapshot');
    expect(snap.approvals.map((a) => a.title)).toEqual(['Claude wants to run: npm i']);
    expect(snap.providers).toEqual([{ name: 'groq', healthy: true }]);
    c.ws.send(JSON.stringify({ type: 'user_message', text: 'hi' }));
    await c.waitFor((m) => m.type === 'chat' && m.entry.role === 'novi' && m.entry.text === 'echo: hi');
    await c.waitFor((m) => m.type === 'speak' && m.text === 'echo: hi');
    c.ws.close();
  });

  it('resolves approvals from the screen and broadcasts them', async () => {
    const approvals = new ApprovalQueue();
    const { ws } = await start({ approvals });
    const c = connect(ws);
    await c.waitFor((m) => m.type === 'snapshot');
    const answer = approvals.request({ title: 'x', tier: 'high', source: 'claude' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    await c.waitFor((m) => m.type === 'speak' && m.text.startsWith('High risk'));
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true }));
    await expect(answer).resolves.toBe(true);
    await c.waitFor((m) => m.type === 'approval_resolved' && m.by === 'screen');
    c.ws.close();
  });
});
