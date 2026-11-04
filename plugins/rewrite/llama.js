import { spawn } from 'node:child_process';

// llama-server (llama.cpp, MIT) on the laptop's CPU, on demand: about 4 s to load, then 1-2 s a
// sentence. It holds about 1 GB of memory, so it stops after idleMs and starts again when needed.
export function createLlama({ command = 'llama-server', model, port = 3019, idleMs = 5 * 60_000, readyMs = 30_000, pollMs = 250, spawnImpl = spawn, fetchImpl = fetch, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let ready = null;
  let idle = null;

  function stop() {
    if (idle) clearTimer(idle);
    idle = null;
    const c = child;
    child = null;
    ready = null;
    try { c?.kill(); } catch { /* already gone */ }
  }

  function keepFor() {
    if (idle) clearTimer(idle);
    idle = setTimer(stop, idleMs);
    idle.unref?.();
  }

  async function waitUp(c) {
    const end = Date.now() + readyMs;
    while (Date.now() < end && child === c) {
      try { if ((await fetchImpl(`${base}/health`)).ok) return; } catch { /* still loading */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (child === c) stop(); // a newer start may already be running
    throw new Error("The local model didn't start.");
  }

  function warm() {
    if (ready) return ready;
    const c = spawnImpl(command, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-ngl', '0', '-c', '2048'], { stdio: 'ignore', windowsHide: true });
    const gone = () => { if (child === c) { child = null; ready = null; } };
    c.on('exit', gone);
    c.on('error', gone);
    child = c;
    ready = waitUp(c);
    ready.catch(() => {});
    keepFor();
    return ready;
  }

  async function ask(system, text, { timeoutMs = 20_000 } = {}) {
    await warm();
    keepFor();
    const res = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ temperature: 0.1, max_tokens: 700, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }),
    });
    if (!res.ok) throw new Error(`The local model answered ${res.status}.`);
    keepFor();
    return String((await res.json()).choices?.[0]?.message?.content || '').trim();
  }

  return { ask, warm, stop };
}
