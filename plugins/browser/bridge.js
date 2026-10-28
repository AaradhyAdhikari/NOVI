// The link between Novi and the Novi Chrome extension: a WebSocket on 127.0.0.1 only. A connection
// counts only if it comes from a Chrome extension (Origin chrome-extension://…) and its first
// message carries the pairing code — so web pages and other programs can't drive the browser.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const NOT_CONNECTED = "The Novi extension isn't connected. Open Chrome (and check the Novi icon).";
const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// "1.10.0" > "1.8.0": compared part by part.
const older = (a, b) => {
  const x = String(a || '0').split('.').map(Number);
  const y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

// wantVersion: the extension version in Novi's folder. An older one is told to reload itself (Chrome then
// reads the new files) — once per old version, so a reload that didn't help can't go round and round.
// onEvent: something the extension reports by itself (a tap on a card's Windows notification,
// 2026-10-28) → its result goes back as { type: 'event_result', ref }.
export function createBridge({ port = 3003, host = '127.0.0.1', code, timeoutMs = 15_000, helloMs = 5_000, logger = console, wantVersion = null, onEvent = null } = {}) {
  const reloadAsked = new Set();
  let server = null;
  let ext = null; // the paired extension socket
  let secret = code;
  let nextId = 1;
  const pending = new Map();

  function drop(reason) {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  }

  return {
    async start() {
      server = new WebSocketServer({
        host, port,
        verifyClient: ({ origin }) => String(origin || '').startsWith('chrome-extension://'),
      });
      server.on('connection', (ws) => {
        let paired = false;
        const hello = setTimeout(() => ws.close(1008, 'no hello'), helloMs);
        ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          if (!paired) {
            clearTimeout(hello);
            if (msg.type !== 'hello' || !same(msg.code, secret)) return ws.close(1008, 'wrong code');
            if (ext && ext.readyState === ext.OPEN) return ws.close(1013, 'already connected');
            paired = true;
            ext = ws;
            this.version = msg.version || null;
            ws.send(JSON.stringify({ type: 'welcome' })); // the extension says "connected" only now
            if (wantVersion && older(this.version, wantVersion) && !reloadAsked.has(this.version)) {
              reloadAsked.add(this.version);
              logger.info?.(`[browser] the Novi extension is ${this.version}, Novi has ${wantVersion}: asking it to reload`);
              ws.send(JSON.stringify({ type: 'reload' }));
            }
            return;
          }
          if (msg.type === 'event') {
            const { type: _t, ref, ...event } = msg;
            Promise.resolve(onEvent ? onEvent(event) : null)
              .then((result) => ws.send(JSON.stringify({ type: 'event_result', ref, ...(result || {}) })))
              .catch((err) => ws.send(JSON.stringify({ type: 'event_result', ref, done: false, text: err.message })));
            return;
          }
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          const { id, ok, error, ...result } = msg;
          if (ok) p.resolve(result); else p.reject(new Error(error || 'failed'));
        });
        ws.on('close', () => { clearTimeout(hello); if (ws === ext) { ext = null; drop(NOT_CONNECTED); } });
        ws.on('error', (err) => logger.warn?.(`[browser] ${err.message}`));
      });
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    },
    stop() { drop('stopped'); ext?.close(); server?.close(); server = null; },
    port: () => server?.address()?.port,
    address: () => server?.address()?.address,
    connected: () => Boolean(ext && ext.readyState === ext.OPEN),
    setCode(c) { secret = c; ext?.close(1008, 'new code'); },
    request(cmd, args = {}, { timeoutMs: ms = timeoutMs } = {}) {
      if (!ext || ext.readyState !== ext.OPEN) return Promise.reject(new Error(NOT_CONNECTED));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, ms);
        pending.set(id, { resolve, reject, timer });
        ext.send(JSON.stringify({ id, cmd, args }));
      });
    },
  };
}
