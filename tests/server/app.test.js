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
  start.pairing = novi.pairing;
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
    const body = await res.json();
    expect(body.text).toBe('heard 4 bytes of audio/webm');
    expect(body.logId).toEqual(expect.any(String)); // Settings → Words can mark it "Wrong"
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
  it('treats a Tailscale (non-loopback) address as remote: pairing required', async () => {
    const { base } = await start({ isLocalAddress: () => false });
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
  });

  it('remote socket answers carry the device id', async () => {
    const approvals = new ApprovalQueue();
    const seen = [];
    const resolve = approvals.resolve.bind(approvals);
    approvals.resolve = (...args) => { seen.push(args[4]); return resolve(...args); };
    const { base, ws } = await start({ approvals, isLocalAddress: () => false });
    const pairRes = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: start.pairing.currentCode().code, name: 'S24+' }) });
    const { token, deviceId } = await pairRes.json();
    const c = connect(ws);
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'hello', token }));
    await c.waitFor((m) => m.type === 'snapshot');
    const answer = approvals.request({ title: 'x', tier: 'medium', source: 'test' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true }));
    await expect(answer).resolves.toBe(true);
    expect(seen.at(-1).from).toEqual({ deviceId });
    c.ws.close();
  });

  it("a revoked device's open socket can no longer act", async () => {
    const approvals = new ApprovalQueue();
    const { base, ws } = await start({ approvals, isLocalAddress: () => false });
    const { token, deviceId } = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: start.pairing.currentCode().code }) })).json();
    const c = connect(ws);
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'hello', token }));
    await c.waitFor((m) => m.type === 'snapshot');
    approvals.request({ title: 'x', tier: 'medium', source: 'test' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    start.pairing.revoke(deviceId);
    const closed = new Promise((r) => c.ws.on('close', (codeNum) => r(codeNum)));
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true }));
    expect(await closed).toBe(4001);
    expect(approvals.pending().map((a) => a.id)).toContain(added.approval.id);
  });

  it('a phone allowing a high-risk approval without its PIN is asked for it, and it stays pending', async () => {
    const { base, ws, novi } = await start({ isLocalAddress: () => false });
    const { token } = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: start.pairing.currentCode().code }) })).json();
    const c = connect(ws);
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'hello', token }));
    await c.waitFor((m) => m.type === 'snapshot');
    novi.approvals.request({ title: 'rm -rf build', tier: 'high', source: 'test' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true }));
    const need = await c.waitFor((m) => m.type === 'approval_needs_proof');
    expect(need).toMatchObject({ id: added.approval.id, need: 'pin' });
    expect(novi.approvals.pending()).toHaveLength(1);
    c.ws.close();
  });

  async function pairedPhone({ base, ws }) {
    const { token, deviceId } = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: start.pairing.currentCode().code }) })).json();
    const c = connect(ws);
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'hello', token }));
    await c.waitFor((m) => m.type === 'snapshot');
    return { c, token, deviceId };
  }

  it('a phone allows a high-risk approval with its spoken PIN, which never shows up anywhere', async () => {
    const env = await start({ isLocalAddress: () => false });
    env.novi.remotePin.set('4829');
    const { c } = await pairedPhone(env);
    const answer = env.novi.approvals.request({ title: 'rm -rf build', tier: 'high', source: 'test' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true, pinSpoken: 'four eight two nine' }));
    await expect(answer).resolves.toBe(true);
    expect(JSON.stringify(env.novi.snapshot())).not.toMatch(/4829|four eight/);
    c.ws.close();
  });

  it('refuses a typed PIN while PIN input is voice only', async () => {
    const env = await start({ isLocalAddress: () => false });
    env.novi.remotePin.set('4829');
    const { c } = await pairedPhone(env);
    env.novi.approvals.request({ title: 'rm -rf build', tier: 'high', source: 'test' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true, pinTyped: '4829' }));
    await c.waitFor((m) => m.type === 'approval_needs_proof');
    expect(env.novi.approvals.pending()).toHaveLength(1);
    c.ws.close();
  });

  it('says so when 3 wrong PINs lock remote high-risk approvals', async () => {
    const env = await start({ isLocalAddress: () => false });
    env.novi.remotePin.set('4829');
    const { c } = await pairedPhone(env);
    env.novi.approvals.request({ title: 'rm -rf build', tier: 'high', source: 'test' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    for (const wrong of ['1111', '2222', '3333']) c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true, pinSpoken: wrong }));
    await c.waitFor((m) => m.type === 'speak' && /wrong PIN 3 times/i.test(m.text));
    c.ws.close();
  });

  it('only the laptop can set the PIN', async () => {
    const env = await start({ isLocalAddress: () => false });
    const { c, token } = await pairedPhone(env);
    const res = await fetch(`${env.base}/api/remote-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pin: '1234' }) });
    expect(res.status).toBe(403);
    c.ws.close();
  });

  it('the laptop sets the PIN and the PIN input setting', async () => {
    const { base, novi } = await start();
    expect((await fetch(`${base}/api/remote-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '12' }) })).status).toBe(400);
    expect((await fetch(`${base}/api/remote-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '482913' }) })).status).toBe(200);
    await fetch(`${base}/api/remote-pin/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinInput: 'voice-or-typed' }) });
    expect(await (await fetch(`${base}/api/remote-pin`)).json()).toMatchObject({ set: true, pinInput: 'voice-or-typed' });
    expect(novi.remotePin.check('482913').ok).toBe(true);
  });

  function fakePasskeys(devices = []) {
    const removed = [];
    return {
      removed,
      has: (id) => devices.includes(id),
      registrationOptions: async () => ({ challenge: 'r' }),
      verifyRegistration: async (id) => { devices.push(id); return true; },
      authOptions: async (id, approvalId) => ({ challenge: `a-${approvalId}` }),
      verifyAuth: async (id, approvalId, response) => response?.ok === true && devices.includes(id),
      removeDevice: (id) => removed.push(id),
    };
  }

  it('a phone confirms a delete with its fingerprint/face passkey', async () => {
    const passkeys = fakePasskeys();
    const env = await start({ isLocalAddress: () => false, passkeys });
    const { c, deviceId, token } = await pairedPhone(env);
    passkeys.verifyRegistration(deviceId);
    const answer = env.novi.approvals.request({ title: 'Forget a memory', tier: 'medium', source: 'test', kind: 'delete' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true }));
    expect(await c.waitFor((m) => m.type === 'approval_needs_proof')).toMatchObject({ need: 'passkey' });
    const opts = await fetch(`${env.base}/api/passkeys/auth/options`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ approvalId: added.approval.id }) });
    expect((await opts.json()).challenge).toBe(`a-${added.approval.id}`);
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true, passkey: { ok: true } }));
    await expect(answer).resolves.toBe(true);
    c.ws.close();
  });

  it('a phone without a passkey is told a delete needs the laptop, and a bad signature is refused', async () => {
    const passkeys = fakePasskeys();
    const env = await start({ isLocalAddress: () => false, passkeys });
    const { c } = await pairedPhone(env);
    env.novi.approvals.request({ title: 'Forget a memory', tier: 'medium', source: 'test', kind: 'delete' });
    const added = await c.waitFor((m) => m.type === 'approval_added');
    c.ws.send(JSON.stringify({ type: 'approval', id: added.approval.id, allow: true, passkey: { ok: true } }));
    expect(await c.waitFor((m) => m.type === 'approval_needs_proof')).toMatchObject({ need: 'laptop' });
    expect(env.novi.approvals.pending()).toHaveLength(1);
    c.ws.close();
  });

  it('removing a phone also removes its passkeys', async () => {
    const passkeys = fakePasskeys();
    const { base, novi } = await start({ passkeys });
    const { deviceId } = novi.pairing.pair(novi.pairing.currentCode().code, 'S24+');
    await fetch(`${base}/api/devices/${deviceId}`, { method: 'DELETE' });
    expect(passkeys.removed).toEqual([deviceId]);
  });

  it('passkey setup needs the Tailscale address', async () => {
    const env = await start({ isLocalAddress: () => false });
    const { c, token } = await pairedPhone(env);
    const res = await fetch(`${env.base}/api/passkeys/register/options`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(409);
    c.ws.close();
  });

  it('answers only on the device that asked', async () => {
    const env = await start({ isLocalAddress: () => false });
    const a = await pairedPhone(env);
    const b = await pairedPhone(env);
    a.c.ws.send(JSON.stringify({ type: 'user_message', text: 'what time is it' }));
    await a.c.waitFor((m) => m.type === 'chat' && m.entry.text === 'echo: what time is it');
    await a.c.waitFor((m) => m.type === 'speak' && m.text === 'echo: what time is it');
    await new Promise((r) => setTimeout(r, 100));
    expect(b.c.messages.some((m) => m.type === 'chat' || m.type === 'speak' || m.type === 'thinking')).toBe(false);
    a.c.ws.send(JSON.stringify({ type: 'hello' }));
    const bSnap = b.c.messages.filter((m) => m.type === 'snapshot').at(-1);
    expect(bSnap.transcript).toEqual([]);
    a.c.ws.close(); b.c.ws.close();
  });

  it('a command heard by the laptop mic is answered on the laptop, not the phone', async () => {
    const spoken = [];
    const env = await start({ isLocalAddress: () => false, localSpeaker: (t) => spoken.push(t) });
    const phone = await pairedPhone(env);
    await env.novi.runVoiceCommand(Buffer.from('wav'));
    expect(spoken).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(phone.c.messages.some((m) => m.type === 'speak' || m.type === 'chat')).toBe(false);
    phone.c.ws.close();
  });

  it('task and reminder speech goes to the device used last', async () => {
    const env = await start({ isLocalAddress: () => false });
    const a = await pairedPhone(env);
    const b = await pairedPhone(env);
    a.c.ws.send(JSON.stringify({ type: 'user_message', text: 'start' }));
    await a.c.waitFor((m) => m.type === 'speak');
    env.novi.tasks.emit('speak', 'Task done.');
    await a.c.waitFor((m) => m.type === 'speak' && m.text === 'Task done.');
    await new Promise((r) => setTimeout(r, 100));
    expect(b.c.messages.some((m) => m.type === 'speak')).toBe(false);
    a.c.ws.close(); b.c.ws.close();
  });

  it('sends pictures only to the device that asked, keeping just the caption in the transcript', async () => {
    const env = await start({ isLocalAddress: () => false });
    const a = await pairedPhone(env);
    const b = await pairedPhone(env);
    a.c.ws.send(JSON.stringify({ type: 'user_message', text: 'show me the screen' }));
    await a.c.waitFor((m) => m.type === 'speak');
    env.novi.plugins.runtime.showImage({ png: Buffer.from('PNG'), caption: 'The laptop screen right now.' });
    const chat = await a.c.waitFor((m) => m.type === 'chat' && m.entry.image);
    expect(chat.entry.image).toBe(`data:image/png;base64,${Buffer.from('PNG').toString('base64')}`);
    expect(JSON.stringify(env.novi.snapshot(a.deviceId))).not.toContain('base64');
    await new Promise((r) => setTimeout(r, 100));
    expect(b.c.messages.some((m) => m.type === 'chat')).toBe(false);
    a.c.ws.close(); b.c.ws.close();
  });

  it('records "Hey Novi" practice clips through the wake-word mic and applies a trigger level', async () => {
    const { base, novi } = await start();
    expect((await (await fetch(`${base}/api/wake-samples`)).json()).available).toBe(false);
    const applied = [];
    let n = 0;
    novi.setWakeTools({ capture: async (ms) => ({ audio: new Int16Array(ms * 16), best: [0.3, 0.2, 0.25, 0.4, 0.35, 0.22, 0.28, 0.31, 0.27, 0.33][n++] }), setThreshold: (t) => applied.push(t), threshold: 0.35 });
    for (let i = 0; i < 10; i++) {
      const res = await (await fetch(`${base}/api/wake-samples`, { method: 'POST' })).json();
      expect(res.count).toBe(i + 1);
    }
    const info = await (await fetch(`${base}/api/wake-samples`)).json();
    expect(info).toMatchObject({ available: true, count: 10, threshold: 0.35, suggested: 0.2 });
    const put = await fetch(`${base}/api/wake-samples/threshold`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threshold: 0.2 }) });
    expect(put.status).toBe(200);
    expect(applied).toEqual([0.2]);
    expect(novi.wakeThreshold()).toBe(0.2);
  });

  it('only the laptop can record wake-word clips', async () => {
    const env = await start({ isLocalAddress: () => false });
    const { c, token } = await pairedPhone(env);
    expect((await fetch(`${env.base}/api/wake-samples`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    c.ws.close();
  });

  function fakePush() {
    const sent = [];
    const subs = new Set();
    const removed = [];
    return { sent, removed, publicKey: 'PUB', subscribe: (id) => { subs.add(id); return true; }, has: (id) => subs.has(id), removeDevice: (id) => { removed.push(id); subs.delete(id); }, send: async (id, m) => { sent.push([id, m.kind]); } };
  }

  it('a phone without Novi open gets a notification, and hears what it missed when it comes back', async () => {
    const push = fakePush();
    const env = await start({ isLocalAddress: () => false, push });
    const phone = await pairedPhone(env);
    expect((await fetch(`${env.base}/api/push/key`, { headers: { Authorization: `Bearer ${phone.token}` } }).then((r) => r.json())).publicKey).toBe('PUB');
    const sub = await fetch(`${env.base}/api/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${phone.token}` }, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }) });
    expect(sub.status).toBe(200);
    phone.c.ws.send(JSON.stringify({ type: 'user_message', text: 'start the task' }));
    await phone.c.waitFor((m) => m.type === 'speak');
    phone.c.ws.close();
    await new Promise((r) => setTimeout(r, 100));

    env.novi.approvals.request({ title: 'Edit app.js', tier: 'medium', source: 'test' });
    env.novi.tasks.emit('speak', 'All done, tests pass.');
    env.novi.tasks.emit('task', { active: true, id: 't1', status: 'done' });
    env.novi.tasks.emit('task', { active: true, id: 't1', status: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    expect(push.sent).toEqual([[phone.deviceId, 'approval'], [phone.deviceId, 'task_done']]);

    const back = connect(env.ws);
    await back.opened;
    back.ws.send(JSON.stringify({ type: 'hello', token: phone.token }));
    const missed = await back.waitFor((m) => m.type === 'missed');
    expect(missed.lines).toContain('All done, tests pass.');
    back.ws.close();
    const again = connect(env.ws);
    await again.opened;
    again.ws.send(JSON.stringify({ type: 'hello', token: phone.token }));
    await again.waitFor((m) => m.type === 'snapshot');
    await new Promise((r) => setTimeout(r, 100));
    expect(again.messages.some((m) => m.type === 'missed')).toBe(false);
    again.ws.close();
  });

  it('a phone with Novi open gets no notification', async () => {
    const push = fakePush();
    const env = await start({ isLocalAddress: () => false, push });
    const phone = await pairedPhone(env);
    push.subscribe(phone.deviceId);
    phone.c.ws.send(JSON.stringify({ type: 'user_message', text: 'hi' }));
    await phone.c.waitFor((m) => m.type === 'speak');
    env.novi.approvals.request({ title: 'Edit app.js', tier: 'medium', source: 'test' });
    await new Promise((r) => setTimeout(r, 50));
    expect(push.sent).toEqual([]);
    phone.c.ws.close();
  });

  it('removing a phone removes its notifications', async () => {
    const push = fakePush();
    const { base, novi } = await start({ push });
    const { deviceId } = novi.pairing.pair(novi.pairing.currentCode().code, 'S24+');
    await fetch(`${base}/api/devices/${deviceId}`, { method: 'DELETE' });
    expect(push.removed).toEqual([deviceId]);
  });

  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

  it("lets the owner's own Tailscale phone in without pairing", async () => {
    const tailscaleIdentity = { ownerDevice: async () => ({ name: 'Galaxy S24+' }) };
    const env = await start({ isLocalAddress: () => false, tailscaleIdentity });
    const res = await post(`${env.base}/api/pair/auto`);
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect((await fetch(`${env.base}/api/health`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(env.novi.pairing.listDevices()[0]).toMatchObject({ name: 'Galaxy S24+', via: 'tailscale' });
  });

  it('refuses automatic pairing for anyone else', async () => {
    const env = await start({ isLocalAddress: () => false, tailscaleIdentity: { ownerDevice: async () => null } });
    expect((await post(`${env.base}/api/pair/auto`)).status).toBe(403);
  });

  it('"Ask the laptop": the laptop allows, the phone gets in', async () => {
    let local = false;
    const env = await start({ isLocalAddress: () => local });
    const ask = await (await post(`${env.base}/api/pair/request`, { name: 'Galaxy S24+' })).json();
    expect((await (await fetch(`${env.base}/api/pair/request/${ask.id}?secret=${ask.secret}`)).json()).status).toBe('pending');
    // Only the laptop can see and answer requests.
    expect((await post(`${env.base}/api/pair/requests/${ask.id}`, { allow: true })).status).toBe(401);
    local = true;
    expect(env.novi.snapshot().pairRequests.map((r) => r.name)).toEqual(['Galaxy S24+']);
    expect((await post(`${env.base}/api/pair/requests/${ask.id}`, { allow: true })).status).toBe(200);
    local = false;
    const done = await (await fetch(`${env.base}/api/pair/request/${ask.id}?secret=${ask.secret}`)).json();
    expect(done.status).toBe('allowed');
    expect((await fetch(`${env.base}/api/health`, { headers: { Authorization: `Bearer ${done.token}` } })).status).toBe(200);
  });

  it('the pairing panel gives the laptop a QR link with a one-time code', async () => {
    const { base } = await start();
    const body = await (await fetch(`${base}/api/pairing-code`)).json();
    expect(body.qrUrl).toBe(`https://192.168.1.5:3001/#pair=${body.code}`);
  });

  it('a laptop-mic command returns what was heard and the reply (for conversation mode)', async () => {
    const { novi } = await start();
    expect(await novi.runVoiceCommand(Buffer.from('wav'))).toEqual({ text: 'heard 3 bytes of audio/wav', reply: 'echo: heard 3 bytes of audio/wav' });
  });

  it('plugins get a private-only AI call (Groq), never another provider', async () => {
    const seen = [];
    const router = { status: () => [], chat: async (opts) => { seen.push(opts); return { message: { content: ' Last time you added pairing. ' } }; } };
    const { novi } = await start({ router });
    expect(await novi.plugins.runtime.privateComplete('summarise')).toBe('Last time you added pairing.');
    expect(seen[0]).toMatchObject({ only: 'groq', messages: [{ role: 'user', content: 'summarise' }] });
  });

  it('runtime.say can speak on the laptop only, without a phone notification', async () => {
    const spoken = [];
    const push = { publicKey: 'P', subscribe: () => true, has: () => true, removeDevice() {}, sent: [], send: async (id, m) => { push.sent.push(m.kind); } };
    const env = await start({ isLocalAddress: () => false, push, localSpeaker: (t) => spoken.push(t) });
    const phone = await pairedPhone(env);
    phone.c.ws.send(JSON.stringify({ type: 'user_message', text: 'hi' }));
    await phone.c.waitFor((m) => m.type === 'speak');
    env.novi.plugins.runtime.say('Last time on NOVI: pairing.', { kind: null, local: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(spoken).toEqual(['Last time on NOVI: pairing.']);
    expect(phone.c.messages.filter((m) => m.type === 'speak').map((m) => m.text)).not.toContain('Last time on NOVI: pairing.');
    expect(push.sent).toEqual([]);
    phone.c.ws.close();
  });
});

