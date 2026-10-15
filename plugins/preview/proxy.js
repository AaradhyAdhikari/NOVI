// The preview port: the project's site at the root of its own address (so /assets/… paths work),
// reachable only with a one-time link Novi gives to a paired device. The link's token becomes an
// HttpOnly cookie; it lasts 30 minutes and only for the newest link (one project at a time).
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const COOKIE = 'novi_preview';
const DENIED = 'Ask Novi for a new preview link.';

const cookieOf = (req) => {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
};
const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createPreviewProxy({ port = 3005, tls = null, ttlMs = 30 * 60_000, now = Date.now } = {}) {
  let server = null;
  let current = null; // { project, targetPort, token, expires }
  const valid = (token) => Boolean(current && token && same(token, current.token) && now() < current.expires);

  function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const fromLink = url.searchParams.get('novi');
    if (fromLink !== null) {
      if (!valid(fromLink)) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end(DENIED); return; }
      const secure = tls ? '; Secure' : '';
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${COOKIE}=${fromLink}; HttpOnly${secure}; SameSite=Lax; Path=/` }).end();
      return;
    }
    if (!valid(cookieOf(req))) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end(DENIED); return; }
    const upstream = http.request({ host: '127.0.0.1', port: current.targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${current.targetPort}` } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('The site is not answering. Ask Novi to show it again.'); });
    req.pipe(upstream);
  }

  // WebSockets (hot reload): pass the raw upgrade request through to the site.
  function upgrade(req, socket, head) {
    if (!valid(cookieOf(req))) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const target = net.connect(current.targetPort, '127.0.0.1', () => {
      const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${current.targetPort}` }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head?.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    const end = () => { target.destroy(); socket.destroy(); };
    target.on('error', end);
    socket.on('error', end);
  }

  return {
    async start() {
      server = tls ? https.createServer(tls, handle) : http.createServer(handle);
      server.on('upgrade', upgrade);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
    },
    stop() { server?.close(); server = null; },
    port: () => server?.address()?.port,
    link({ project, targetPort, host }) {
      current = { project, targetPort, token: crypto.randomBytes(24).toString('base64url'), expires: now() + ttlMs };
      return `${tls ? 'https' : 'http'}://${host}:${server.address().port}/?novi=${current.token}`;
    },
  };
}
