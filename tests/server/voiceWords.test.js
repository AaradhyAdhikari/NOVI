import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createNovi } from '../../server/app.js';

let server;
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

async function start(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-words-'));
  const config = { dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand: 'claude', coder: 'free' };
  const fakeTasks = Object.assign(new (await import('node:events')).EventEmitter(), {
    status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {},
  });
  const novi = createNovi(config, {
    tasks: fakeTasks,
    agent: { handle: async (text) => `echo: ${text}` },
    router: { status: () => [] },
    transcribe: async () => 'hey novee open claw',
    cipher: { protect: async (v) => `enc:${v}`, unprotect: async (v) => v.slice(4) },
    ...overrides,
  });
  server = http.createServer(novi.app);
  novi.attachWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { novi, dataDir, base: `http://127.0.0.1:${server.address().port}`, ws: `ws://127.0.0.1:${server.address().port}/ws` };
}

const json = (base, url, method = 'GET', body, headers = {}) => fetch(`${base}${url}`, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
});

describe('word list + misunderstanding log', () => {
  it('fixes misheard words before the brain sees them, and logs both versions with the reply', async () => {
    const env = await start();
    const put = await json(env.base, '/api/vocabulary', 'PUT', { words: ['OpenClaw'], fixes: { novee: 'Novi', 'open claw': 'OpenClaw' } });
    expect(put.status).toBe(200);
    expect(await (await json(env.base, '/api/vocabulary')).json()).toEqual({ words: ['OpenClaw'], fixes: { novee: 'Novi', 'open claw': 'OpenClaw' } });
    const result = await env.novi.runVoiceCommand(Buffer.from('RIFFfake'));
    expect(result).toEqual({ text: 'hey Novi OpenClaw', reply: 'echo: hey Novi OpenClaw' });
    const log = await (await json(env.base, '/api/voice-log')).json();
    expect(log.entries[0]).toMatchObject({ source: 'wake', heard: 'hey novee open claw', text: 'hey Novi OpenClaw', reply: 'echo: hey Novi OpenClaw', hasAudio: true });
  });

  it('the talk button gets the fixed text and its command is logged', async () => {
    const env = await start();
    await json(env.base, '/api/vocabulary', 'PUT', { words: [], fixes: { novee: 'Novi' } });
    const res = await (await fetch(`${env.base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('webm') })).json();
    expect(res.text).toBe('hey Novi open claw');
    const log = await (await json(env.base, '/api/voice-log')).json();
    expect(log.entries[0]).toMatchObject({ id: res.logId, source: 'talk', heard: 'hey novee open claw' });
  });

  it('"Wrong" saves it for the test set and one tap adds the suggested fix', async () => {
    const env = await start();
    await env.novi.runVoiceCommand(Buffer.from('RIFFfake'));
    const [entry] = (await (await json(env.base, '/api/voice-log')).json()).entries;
    const wrong = await (await json(env.base, `/api/voice-log/${entry.id}/wrong`, 'POST', { said: 'hey Novi OpenClaw' })).json();
    expect(wrong).toEqual({ saved: true, suggestion: { from: 'novee open claw', to: 'Novi OpenClaw' } });
    expect(fs.existsSync(path.join(env.dataDir, 'voice-samples', 'real', 'expected.json'))).toBe(true);
    const added = await (await json(env.base, '/api/vocabulary/fix', 'POST', { from: 'open claw', to: 'OpenClaw' })).json();
    expect(added.fixes).toEqual({ 'open claw': 'OpenClaw' });
    expect((await json(env.base, '/api/voice-log/nope/wrong', 'POST', { said: 'x' })).status).toBe(400);
  });

  it('bad word lists are refused', async () => {
    const env = await start();
    const res = await json(env.base, '/api/vocabulary', 'PUT', { words: ['x'.repeat(41)], fixes: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/40 characters/);
  });

  it('only the laptop can see or change the word list and the log', async () => {
    const env = await start({ isLocalAddress: () => false });
    const { token } = await (await json(env.base, '/api/pair', 'POST', { code: env.novi.pairing.currentCode().code })).json();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await json(env.base, '/api/voice-log', 'GET', undefined, auth)).status).toBe(403);
    expect((await json(env.base, '/api/vocabulary', 'PUT', { words: [], fixes: {} }, auth)).status).toBe(403);
    expect((await json(env.base, '/api/vocabulary/fix', 'POST', { from: 'a', to: 'b' }, auth)).status).toBe(403);
    expect((await json(env.base, '/api/voice-log/x/wrong', 'POST', { said: 'x' }, auth)).status).toBe(403);
  });
});
