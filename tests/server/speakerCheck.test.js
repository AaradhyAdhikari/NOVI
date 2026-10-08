import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createNovi } from '../../server/app.js';
import { encodeWav } from '../../src/lib/utterance.js';
import { cosine } from '../../server/voice/speaker/verifier.js';

let server;
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

async function start(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-speaker-'));
  const config = { dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand: 'claude', coder: 'free' };
  const fakeTasks = Object.assign(new (await import('node:events')).EventEmitter(), {
    status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {},
  });
  const novi = createNovi(config, {
    tasks: fakeTasks,
    agent: { handle: async (text) => `echo: ${text}` },
    router: { status: () => [] },
    transcribe: async () => '',
    cipher: { protect: async (v) => `enc:${v}`, unprotect: async (v) => v.slice(4) },
    ...overrides,
  });
  server = http.createServer(novi.app);
  novi.attachWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { novi, dataDir, base: `http://127.0.0.1:${server.address().port}`, ws: `ws://127.0.0.1:${server.address().port}/ws` };
}

// Fake speaker model: the clip's first sample picks its voiceprint. 1–6 = the owner, 9 = someone else.
const VECTORS = { 1: [1, 0.1, 0], 2: [1, 0, 0.1], 3: [0.9, 0.1, 0.1], 4: [1, 0.05, 0.05], 5: [1, 0.12, 0], 6: [0.95, 0, 0.12], 9: [0, 1, 0] };
const fakeVerifier = ({ dim = 3, broken = false } = {}) => ({
  dim,
  model: 'fake.onnx',
  embed(audio) {
    if (broken) throw new Error('model crashed');
    return Float32Array.from(VECTORS[Math.round(audio[0] / 1000)]);
  },
  score: cosine,
});
const voice = (n) => Int16Array.from([n * 1000, 0, 0]);
function recordClips(dataDir, values = [1, 2, 3, 4, 5, 6]) {
  const dir = path.join(dataDir, 'voice-samples', 'hey-novi');
  fs.mkdirSync(dir, { recursive: true });
  values.forEach((n, i) => fs.writeFileSync(path.join(dir, `clip-00${i + 1}.wav`), encodeWav(Float32Array.from([(n * 1000) / 32768, 0, 0]), 16000)));
}
const json = (base, url, method = 'GET', body, headers = {}) => fetch(`${base}${url}`, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body),
});

describe('only my voice (speaker check)', () => {
  it('learns the owner\'s voice from the Hey Novi clips without ever showing the voiceprint', async () => {
    const env = await start();
    recordClips(env.dataDir);
    expect((await json(env.base, '/api/voiceprint/learn', 'POST')).status).toBe(409); // no model yet
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
    const res = await json(env.base, '/api/voiceprint/learn', 'POST');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ learned: true, enabled: true, clipCount: 6, model: 'fake.onnx' });
    expect(body).not.toHaveProperty('voiceprint');
    const info = await (await json(env.base, '/api/voiceprint')).json();
    expect(info).toMatchObject({ available: true, status: 'ready', learned: true });
    expect(info).not.toHaveProperty('voiceprint');
  });

  it('says why learning failed', async () => {
    const env = await start();
    recordClips(env.dataDir, [1, 2, 3]);
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
    const res = await json(env.base, '/api/voiceprint/learn', 'POST');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Record at least 5 'Hey Novi' clips first.");
  });

  it('only the laptop can learn or change the voice check', async () => {
    const env = await start({ isLocalAddress: () => false });
    const { token } = await (await json(env.base, '/api/pair', 'POST', { code: env.novi.pairing.currentCode().code })).json();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await json(env.base, '/api/voiceprint/learn', 'POST', undefined, auth)).status).toBe(403);
    expect((await json(env.base, '/api/voiceprint', 'PUT', { enabled: false }, auth)).status).toBe(403);
  });

  it('accepts the owner, refuses someone else, and is "off" when switched off', async () => {
    const env = await start();
    recordClips(env.dataDir);
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
    expect(env.novi.checkVoice(voice(1))).toEqual({ ok: null, score: null }); // not learned yet
    await json(env.base, '/api/voiceprint/learn', 'POST');
    const owner = env.novi.checkVoice(voice(1));
    expect(owner.ok).toBe(true);
    expect(owner.score).toBeGreaterThan(0.9);
    expect(env.novi.checkVoice(voice(9)).ok).toBe(false);
    expect((await json(env.base, '/api/voiceprint', 'PUT', { strictness: 2 })).status).toBe(400);
    expect((await json(env.base, '/api/voiceprint', 'PUT', { enabled: false })).status).toBe(200);
    expect(env.novi.checkVoice(voice(9))).toEqual({ ok: null, score: null });
  });

  it('never goes deaf: a crashing model or a voiceprint from another model counts as "off"', async () => {
    const env = await start();
    recordClips(env.dataDir);
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
    await json(env.base, '/api/voiceprint/learn', 'POST');
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier({ broken: true }), status: 'ready' });
    expect(env.novi.checkVoice(voice(9))).toEqual({ ok: null, score: null });
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier({ dim: 4 }), status: 'ready' });
    expect(env.novi.checkVoice(voice(9))).toEqual({ ok: null, score: null });
    expect((await (await json(env.base, '/api/health')).json()).speakerCheck).toBe('relearn');
  });

  it('reports the voice check in health', async () => {
    const env = await start();
    const health = async () => (await (await json(env.base, '/api/health')).json()).speakerCheck;
    expect(await health()).toBe('no-model');
    env.novi.setSpeakerVerifier({ verifier: null, status: 'error', error: 'bad' });
    expect(await health()).toBe('error');
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
    expect(await health()).toBe('off');
    recordClips(env.dataDir);
    await json(env.base, '/api/voiceprint/learn', 'POST');
    expect(await health()).toBe('on');
  });

  it('shows how well a practice clip matches the owner', async () => {
    const env = await start();
    recordClips(env.dataDir);
    env.novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
    await json(env.base, '/api/voiceprint/learn', 'POST');
    env.novi.setWakeTools({ capture: async () => ({ audio: voice(2), best: 0.4 }), setThreshold: () => {}, threshold: 0.35 });
    const res = await (await json(env.base, '/api/wake-samples', 'POST')).json();
    expect(res.voiceMatch).toBeGreaterThan(0.9);
  });
});

describe('stopping Novi mid-reply', () => {
  it('silences the laptop voice and tells open laptop pages to stop', async () => {
    let stopped = 0;
    const localSpeaker = Object.assign(async () => {}, { stop: () => { stopped += 1; } });
    const env = await start({ localSpeaker });
    const ws = new WebSocket(env.ws);
    const messages = [];
    ws.on('message', (d) => messages.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    await new Promise((r) => setTimeout(r, 50));
    env.novi.stopSpeaking();
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(1);
    expect(messages.some((m) => m.type === 'stop_speaking')).toBe(true);
    ws.close();
  });

  it('tells the wake listener when the laptop starts and stops talking', async () => {
    let finish;
    const localSpeaker = () => new Promise((r) => { finish = r; });
    const env = await start({ localSpeaker });
    const speaking = [];
    env.novi.setWakeTools({ capture: async () => ({}), setThreshold: () => {}, threshold: 0.35, setSpeaking: (on) => speaking.push(on) });
    env.novi.broadcast({ type: 'speak', text: 'hello there' }); // no page open → laptop speakers
    expect(speaking).toEqual([true]);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(speaking).toEqual([true, false]);
  });
});
