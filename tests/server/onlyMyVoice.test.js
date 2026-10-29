import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createNovi } from '../../server/app.js';
import { encodeWav } from '../../src/lib/utterance.js';
import { cosine } from '../../server/voice/speaker/verifier.js';

// "Only my voice" on every voice path: the talk button and the phone app (/api/stt), the laptop
// wake word (runVoiceCommand) and dictation all go through hear(); typed text is never checked.
let server;
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

const VECTORS = { 1: [1, 0.1, 0], 2: [1, 0, 0.1], 3: [0.9, 0.1, 0.1], 4: [1, 0.05, 0.05], 5: [1, 0.12, 0], 6: [0.95, 0, 0.12], 9: [0, 1, 0] };
const fakeVerifier = () => ({
  dim: 3,
  model: 'fake.onnx',
  embed: (audio) => Float32Array.from(VECTORS[Math.round(audio[0] / 1000)]),
  score: cosine,
});
const wav = (n) => Buffer.from(encodeWav(Float32Array.from([(n * 1000) / 32768, 0, 0]), 16000));

async function start({ heard = 'what time is it', wantsPin = false, learn = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-myvoice-'));
  const config = { dataDir, providers: [], order: { fast: [], long: [] }, claudeCommand: 'claude', coder: 'free' };
  const fakeTasks = Object.assign(new (await import('node:events')).EventEmitter(), {
    status: () => ({ active: false }), stop: async () => false, setAllowEdits: () => {}, shutdown: async () => {},
  });
  const calls = { stt: 0, agent: [] };
  const novi = createNovi(config, {
    tasks: fakeTasks,
    agent: { handle: async (text) => { calls.agent.push(text); return `echo: ${text}`; }, wantsPin: () => wantsPin },
    router: { status: () => [] },
    transcribe: async () => { calls.stt += 1; return heard; },
    cipher: { protect: async (v) => `enc:${v}`, unprotect: async (v) => v.slice(4) },
  });
  server = http.createServer(novi.app);
  novi.attachWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  novi.setSpeakerVerifier({ verifier: fakeVerifier(), status: 'ready' });
  if (learn) {
    const dir = path.join(dataDir, 'voice-samples', 'hey-novi');
    fs.mkdirSync(dir, { recursive: true });
    [1, 2, 3, 4, 5, 6].forEach((n, i) => fs.writeFileSync(path.join(dir, `clip-00${i + 1}.wav`), wav(n)));
    await fetch(`${base}/api/voiceprint/learn`, { method: 'POST' });
  }
  return { novi, base, calls, ws: `ws://127.0.0.1:${server.address().port}/ws` };
}
const stt = (base, body, type = 'audio/wav') => fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': type }, body }).then((r) => r.json());
async function page(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 50));
  return { ws, messages, spoken: () => messages.filter((m) => m.type === 'speak').map((m) => m.text) };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('only my voice on every voice path', () => {
  it('the talk button / phone app: the owner is heard as before', async () => {
    const env = await start();
    expect(await stt(env.base, wav(1))).toMatchObject({ text: 'what time is it' });
    expect(env.calls.stt).toBe(1);
  });

  it('someone else is not transcribed, gets "That didn\'t sound like you." once, and is logged', async () => {
    const env = await start();
    const p = await page(env.ws);
    const out = await stt(env.base, wav(9));
    expect(out).toMatchObject({ text: '', notYou: true, message: "That didn't sound like you." });
    expect(env.calls.stt).toBe(0); // no speech-to-text quota spent on a stranger
    await stt(env.base, wav(9));
    await tick();
    expect(p.spoken()).toEqual(["That didn't sound like you."]); // said once, not every time
    const entries = (await (await fetch(`${env.base}/api/activity`)).json()).entries;
    const notYou = entries.filter((e) => e.route === 'not your voice');
    expect(notYou).toHaveLength(2);
    expect(notYou[0].heard).toBe('(a voice that isn\'t yours)'); // never what the stranger said
    expect(typeof notYou[0].ms).toBe('number');
    expect(env.calls.agent).toEqual([]);
    p.ws.close();
  });

  it('the laptop wake word: a stranger\'s command never reaches the brain', async () => {
    const env = await start();
    expect(await env.novi.runVoiceCommand(wav(9))).toBeNull();
    expect(env.calls.agent).toEqual([]);
    expect(await env.novi.runVoiceCommand(wav(1))).toMatchObject({ text: 'what time is it' });
    expect(env.calls.agent).toEqual(['what time is it']);
  });

  it('a follow-up the wake listener already checked is not checked twice', async () => {
    const env = await start();
    let embeds = 0;
    const v = fakeVerifier();
    env.novi.setSpeakerVerifier({ verifier: { ...v, embed: (a) => { embeds += 1; return v.embed(a); } }, status: 'ready' });
    await env.novi.runVoiceCommand(wav(1), { followUp: true, voiceChecked: true });
    expect(embeds).toBe(0);
    await env.novi.runVoiceCommand(wav(1));
    expect(embeds).toBe(1);
  });

  it('typed text is never checked', async () => {
    const env = await start();
    await stt(env.base, wav(9));
    expect(await env.novi.handleMessage({ type: 'user_message', text: 'hello' })).toBe('echo: hello');
  });

  it('a spoken PIN still works (the PIN is the proof) — but other words from that voice do not', async () => {
    const pin = await start({ heard: '4 8 2 9', wantsPin: true });
    expect(await stt(pin.base, wav(9))).toMatchObject({ text: '4 8 2 9' });
    const other = await start({ heard: 'approve', wantsPin: true });
    expect(await stt(other.base, wav(9))).toMatchObject({ text: '', notYou: true });
  });

  it('keeps working for anyone when no voice is learned, the check is off, or the audio can\'t be checked', async () => {
    const none = await start({ learn: false });
    expect(await stt(none.base, wav(9))).toMatchObject({ text: 'what time is it' });
    expect(await (await fetch(`${none.base}/api/voiceprint`)).json()).toMatchObject({ check: 'off', learned: false });

    const off = await start();
    await fetch(`${off.base}/api/voiceprint`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(await stt(off.base, wav(9))).toMatchObject({ text: 'what time is it' });

    const webm = await start();
    expect(await stt(webm.base, Buffer.from('not a wav'), 'audio/webm')).toMatchObject({ text: 'what time is it' });
  });
});
