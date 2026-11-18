import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One llama-server (llama.cpp, MIT) for the whole laptop, on its CPU, started only when something needs it
// (dictation polish, or the brain when every cloud AI is down) and stopped after idleMs. One server, not one per
// feature: each holds the model in memory. It answers one request at a time (-np 1).
export const MODEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', 'llm');
const PREFERRED = ['qwen2.5-3b-instruct-q4_k_m.gguf', 'qwen2.5-1.5b-instruct-q4_k_m.gguf'];
const HEADROOM = 600 * 1024 * 1024; // KV cache (8k context) + the server itself, on top of the model file
const MAX_TOOLS = 6;
const MAX_MESSAGES = 6;

// The best model on disk: the 3B when it's there (better answers), else the 1.5B.
export function pickModelFile(names) {
  for (const want of PREFERRED) if (names.includes(want)) return want;
  return names.find((n) => n.endsWith('.gguf')) || null;
}

export function defaultModelPath(dir = MODEL_DIR) {
  try { const name = pickModelFile(fs.readdirSync(dir)); return name ? path.join(dir, name) : null; } catch { return null; }
}

// Every known model on disk, best first: the 3B when memory allows, else the 1.5B.
export function defaultModelPaths(dir = MODEL_DIR) {
  try { const names = fs.readdirSync(dir); return PREFERRED.filter((n) => names.includes(n)).map((n) => path.join(dir, n)); } catch { return []; }
}

// Small models lose the thread on long chats: the system prompt plus the last few messages, never starting
// on a tool result whose call was cut off.
export function trimForLocal(messages, keep = MAX_MESSAGES) {
  const system = messages.filter((m) => m.role === 'system');
  let rest = messages.filter((m) => m.role !== 'system').slice(-keep);
  while (rest.length && rest[0].role === 'tool') rest = rest.slice(1);
  return [...system, ...rest];
}

export function createLocalModel({
  command = 'llama-server', model = null, models = model ? [model] : defaultModelPaths(), port = 3019, idleMs = 5 * 60_000, readyMs = 60_000, pollMs = 250,
  context = 8192, freemem = os.freemem, fileSize = (f) => fs.statSync(f).size,
  spawnImpl = spawn, fetchImpl = fetch, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let ready = null;
  let up = false;
  let idle = null;

  function stop() {
    if (idle) clearTimer(idle);
    idle = null;
    const c = child;
    child = null;
    ready = null;
    up = false;
    try { c?.kill(); } catch { /* already gone */ }
  }

  function keepFor() {
    if (idle) clearTimer(idle);
    idle = setTimer(stop, idleMs);
    idle?.unref?.();
  }

  async function waitUp(c) {
    const end = Date.now() + readyMs;
    while (Date.now() < end && child === c) {
      try { if ((await fetchImpl(`${base}/health`)).ok) { up = true; return; } } catch { /* still loading */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (child === c) stop(); // a newer start may already be running
    throw new Error("The local model didn't start.");
  }

  // Never push the laptop into swapping: the model file plus headroom must fit in what's free.
  // The best model that fits right now (the 3B, else the smaller one).
  let chosen = null;
  function roomFor() {
    if (!models.length) throw new Error('No local model file in models/llm.');
    const free = freemem();
    let smallest = Infinity;
    for (const m of models) {
      let need;
      try { need = fileSize(m) + HEADROOM; } catch { continue; }
      smallest = Math.min(smallest, need);
      if (free >= need) { chosen = m; return; }
    }
    if (smallest === Infinity) throw new Error('The local model file is missing.');
    throw new Error(`Not enough free memory for the offline model (${(free / 2 ** 30).toFixed(1)} GB free, needs ${(smallest / 2 ** 30).toFixed(1)} GB).`);
  }

  function warm() {
    if (ready) return ready;
    try { roomFor(); } catch (err) { return Promise.reject(err); }
    const c = spawnImpl(command, ['-m', chosen, '--host', '127.0.0.1', '--port', String(port), '-ngl', '0', '-c', String(context), '-np', '1', '--jinja'], { stdio: 'ignore', windowsHide: true });
    const gone = () => { if (child === c) { child = null; ready = null; up = false; } };
    c.on('exit', gone);
    c.on('error', gone);
    child = c;
    ready = waitUp(c);
    ready.catch(() => {});
    keepFor();
    return ready;
  }

  async function post(body, timeoutMs) {
    await warm();
    keepFor();
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`The local model answered ${res.status}.`);
    keepFor();
    return (await res.json()).choices?.[0]?.message || {};
  }

  // Dictation polish / edits (plugins/rewrite).
  async function ask(system, text, { timeoutMs = 20_000 } = {}) {
    const msg = await post({ temperature: 0.1, max_tokens: 700, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }, timeoutMs);
    return String(msg.content || '').trim();
  }

  // The brain's last resort (router provider "local"): an OpenAI-style message back.
  async function chat({ messages, tools, timeoutMs = 120_000 }) {
    const body = { temperature: 0.3, max_tokens: 600, messages: trimForLocal(messages) };
    if (tools?.length) body.tools = tools.slice(0, MAX_TOOLS);
    const msg = await post(body, timeoutMs);
    const out = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
    return out;
  }

  const status = () => ({ state: up ? 'ready' : ready ? 'starting' : 'asleep', model: path.basename(chosen || models[0] || '') || null });

  return { ask, chat, warm, stop, status };
}
