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
