import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createBridge } from '../../plugins/browser/bridge.js';

let bridge;
afterEach(() => bridge?.stop());
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
// Wait for a condition (≤ 2 s) instead of a fixed 50 ms — a busy laptop can be slower.
const until = async (ok, ms = 2000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await tick(20); };

async function start(opts = {}) {
  bridge = createBridge({ port: 0, code: 'secret-code', logger: { warn() {} }, ...opts });
  await bridge.start();
  return bridge.port();
}
function connect(port, { origin = ORIGIN, code = 'secret-code' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
  const state = { closed: false, messages: [] };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', code, version: '1' })));
  ws.on('message', (d) => state.messages.push(JSON.parse(d)));
  ws.on('close', () => { state.closed = true; });
  ws.on('error', () => {});
  return { ws, state };
}

describe('browser bridge (Novi ⇄ extension)', () => {
  it('listens on 127.0.0.1 only and accepts the extension with the right code', async () => {
    const port = await start();
    expect(bridge.address()).toBe('127.0.0.1');
    const { state } = connect(port);
    await until(() => state.messages.length > 0);
    expect(bridge.connected()).toBe(true);
    expect(state.closed).toBe(false);
    expect(state.messages[0]).toEqual({ type: 'welcome' }); // the extension shows "connected" only now
  });

  it('refuses web pages and wrong codes', async () => {
    const port = await start();
    const page = connect(port, { origin: 'https://evil.example' });
    const wrong = connect(port, { code: 'nope' });
    await tick(100);
    expect(page.state.closed).toBe(true);
    expect(wrong.state.closed).toBe(true);
    expect(bridge.connected()).toBe(false);
  });

  it('one extension at a time', async () => {
    const port = await start();
    const first = connect(port);
    await tick();
    const second = connect(port);
    await tick(100);
    expect(first.state.closed).toBe(false);
    expect(second.state.closed).toBe(true);
  });

  it('requests get their own answers; failures and silence reject', async () => {
    const port = await start({ timeoutMs: 150 });
    const { ws, state } = connect(port);
    await tick();
    const p = bridge.request('read', { x: 1 });
    await tick();
    const msg = state.messages.at(-1);
    expect(msg).toMatchObject({ cmd: 'read', args: { x: 1 } });
    ws.send(JSON.stringify({ id: msg.id, ok: true, url: 'https://x.com' }));
    expect(await p).toEqual({ url: 'https://x.com' });
    const bad = bridge.request('click', { n: 9 });
    await tick();
    ws.send(JSON.stringify({ id: state.messages.at(-1).id, ok: false, error: 'no item 9' }));
    await expect(bad).rejects.toThrow('no item 9');
    await expect(bridge.request('read')).rejects.toThrow('timeout');
  });

  it('not connected says how to fix it', async () => {
    await start();
    await expect(bridge.request('read')).rejects.toThrow("The Novi extension isn't connected. Open Chrome (and check the Novi icon).");
  });
});

// 2026-10-22: Novi's own window needs extension 1.8.0. An older extension is told to reload itself
// (Chrome then reads the new files from the folder) — once, so a reload that didn't help can't loop.
describe('browser bridge: an old extension updates itself', () => {
  function hello(port, version) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: ORIGIN } });
    const state = { messages: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', code: 'secret-code', version })));
    ws.on('message', (d) => state.messages.push(JSON.parse(d)));
    ws.on('error', () => {});
    return { ws, state };
  }

  it('older than wanted → told to reload, once; the wanted version or newer → not', async () => {
    const port = await start({ wantVersion: '1.8.0' });
    const old = hello(port, '1.7.0');
    await tick();
    expect(old.state.messages).toContainEqual({ type: 'reload' });
    old.ws.close();
    await tick();
    const still = hello(port, '1.7.0'); // the reload didn't help (folder not updated?)
    await tick();
    expect(still.state.messages).not.toContainEqual({ type: 'reload' });
    still.ws.close();
    await tick();
    const fresh = hello(port, '1.10.0');
    await tick();
    expect(fresh.state.messages).toEqual([{ type: 'welcome' }]);
  });
});
