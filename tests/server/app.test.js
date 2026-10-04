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
  return { novi, base, ws: base.replace('http', 'ws') + '/ws' };
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
