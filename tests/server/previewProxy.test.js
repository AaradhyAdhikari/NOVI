import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createPreviewProxy } from '../../plugins/preview/proxy.js';

const closers = [];
afterEach(() => { while (closers.length) closers.pop()(); });

async function target(name) {
  const server = http.createServer((req, res) => res.end(`${name} ${req.method} ${req.url}`));
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { wss.close(); server.close(); });
  return server.address().port;
}
async function proxy(opts = {}) {
  const p = createPreviewProxy({ port: 0, ...opts });
  await p.start();
  closers.push(() => p.stop());
  return p;
}
const open = async (url, cookie) => fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });

describe('preview port: one-time links', () => {
  it('no token → 403; the link sets a cookie and the site comes through', async () => {
    const p = await proxy();
    const link = p.link({ project: 'portfolio', targetPort: await target('A'), host: '127.0.0.1' });
    expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${p.port()}/\\?novi=[\\w-]{20,}$`));
    const none = await open(`http://127.0.0.1:${p.port()}/`);
    expect(none.status).toBe(403);
    expect(await none.text()).toBe('Ask Novi for a new preview link.');
    const first = await open(link);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/');
    const cookie = first.headers.get('set-cookie').split(';')[0];
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly/);
    const page = await open(`http://127.0.0.1:${p.port()}/contact`, cookie);
    expect(await page.text()).toBe('A GET /contact');
  });

  it('expires after 30 minutes', async () => {
    let t = 1_000_000;
    const p = await proxy({ now: () => t });
    const link = p.link({ project: 'portfolio', targetPort: await target('A'), host: '127.0.0.1' });
    const cookie = (await open(link)).headers.get('set-cookie').split(';')[0];
    t += 31 * 60_000;
    expect((await open(`http://127.0.0.1:${p.port()}/`, cookie)).status).toBe(403);
    expect((await open(link)).status).toBe(403);
  });

  it('a newer link for another project makes the old one useless', async () => {
    const p = await proxy();
    const linkA = p.link({ project: 'a', targetPort: await target('A'), host: '127.0.0.1' });
    const cookieA = (await open(linkA)).headers.get('set-cookie').split(';')[0];
    p.link({ project: 'b', targetPort: await target('B'), host: '127.0.0.1' });
    expect((await open(`http://127.0.0.1:${p.port()}/`, cookieA)).status).toBe(403);
  });

  it('WebSockets (hot reload) go through with the cookie, not without', async () => {
    const p = await proxy();
    const link = p.link({ project: 'a', targetPort: await target('A'), host: '127.0.0.1' });
    const cookie = (await open(link)).headers.get('set-cookie').split(';')[0];
    const ws = new WebSocket(`ws://127.0.0.1:${p.port()}/hmr`, { headers: { cookie } });
    const reply = await new Promise((resolve, reject) => { ws.on('open', () => ws.send('hi')); ws.on('message', (m) => resolve(String(m))); ws.on('error', reject); });
    expect(reply).toBe('echo hi');
    ws.close();
    const bad = new WebSocket(`ws://127.0.0.1:${p.port()}/hmr`);
    await expect(new Promise((resolve, reject) => { bad.on('open', resolve); bad.on('error', reject); })).rejects.toThrow(/403/);
  });
});

const hasIpv6 = await new Promise((resolve) => { const s = http.createServer(); s.once('error', () => resolve(false)); s.listen(0, '::1', () => s.close(() => resolve(true))); });
describe('preview port: sites that listen on IPv6 localhost (Vite on newer Node)', () => {
  it.skipIf(!hasIpv6)('reaches a site listening only on ::1 (skipped on machines without IPv6)', async () => {
    const server = http.createServer((req, res) => res.end('v6 site'));
    await new Promise((r) => server.listen(0, '::1', r));
    closers.push(() => server.close());
    const p = await proxy();
    const link = p.link({ project: 'a', targetPort: server.address().port, host: '127.0.0.1' });
    const cookie = (await open(link)).headers.get('set-cookie').split(';')[0];
    expect(await (await open(`http://127.0.0.1:${p.port()}/`, cookie)).text()).toBe('v6 site');
  });
});
