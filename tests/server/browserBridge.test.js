import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createBridge } from '../../plugins/browser/bridge.js';

let bridge;
afterEach(() => bridge?.stop());
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

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
    await tick();
    expect(bridge.connected()).toBe(true);
    expect(state.closed).toBe(false);
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
