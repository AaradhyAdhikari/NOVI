// The laptop stage's own little server on 127.0.0.1 (no certificate warnings, never reachable from outside).
// Everything lives under a random path made at each start (security review: a rebinding web page can reach
// 127.0.0.1 but can't guess it), and the Host header must be our own address.
// GET / = the stage page, /events = new items (server-sent events), /file/<id> = a received picture or video
// (only those). POST /open/<id> and /close need the x-novi-stage header, which a web page elsewhere can't
// send without a preflight this server never answers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage.html');
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };
const KEEP = 8;

// What the page may see of an item: never the laptop path.
const pub = ({ id, kind, name, url, host, at, text, link }) => ({ id, kind, name, url, host, at, ...(link ? { link } : {}), ...(text ? { text: text.slice(0, 600) } : {}), openable: Boolean(url) || ['photo', 'video', 'doc'].includes(kind), sendable: Boolean(url) || ['photo', 'video', 'doc'].includes(kind), preview: !url && (kind === 'photo' || kind === 'video') }); // a link (YouTube…) has no file to show

export function createStage() {
  const items = [];
  const clients = new Set();
  let server = null;
  let base = null;
  let secret = null;
  const stage = {
    handle: { open: () => {}, close: () => {}, action: async () => null },
    async start() {
      if (base) return base;
      secret = crypto.randomBytes(16).toString('hex');
      server = http.createServer((req, res) => {
        const own = `127.0.0.1:${server.address().port}`;
        if (req.headers.host !== own) { res.writeHead(403); return res.end(); }
        const raw = new URL(req.url, 'http://x');
        if (!raw.pathname.startsWith(`/${secret}/`)) { res.writeHead(404); return res.end(); }
        const url = { pathname: raw.pathname.slice(secret.length + 1) };
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return fs.createReadStream(PAGE).pipe(res);
        }
        if (req.method === 'GET' && url.pathname === '/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(`event: hello\ndata: ${JSON.stringify(items.map(pub))}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        const file = url.pathname.match(/^\/file\/([\w-]+)$/);
        if (req.method === 'GET' && file) {
          const it = items.find((i) => i.id === file[1]);
          if (!it || !pub(it).preview || !it.path || !fs.existsSync(it.path)) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'Content-Type': TYPES[path.extname(it.path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return fs.createReadStream(it.path).pipe(res);
        }
        if (req.method === 'POST' && req.headers['x-novi-stage'] === '1') {
          const open = url.pathname.match(/^\/open\/([\w-]+)$/);
          if (open) { stage.handle.open(open[1]); res.writeHead(204); return res.end(); }
          // ✕ on a card: off the stage (the file stays saved).
          const gone = url.pathname.match(/^\/remove\/([\w-]+)$/);
          if (gone) { stage.remove(gone[1]); res.writeHead(204); return res.end(); }
          if (url.pathname === '/close') { stage.handle.close(); res.writeHead(204); return res.end(); }
          // A card's action (v2): { do, to?, app? } as a small JSON body; the answer is a short note for the page.
          const act = url.pathname.match(/^\/action\/([\w-]+)$/);
          if (act) {
            let body = '';
            req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
            req.on('end', async () => {
              let data = {};
              try { data = JSON.parse(body || '{}'); } catch { data = {}; }
              const out = await Promise.resolve(stage.handle.action?.(act[1], { do: String(data.do || ''), to: data.to ? String(data.to) : undefined, app: data.app ? String(data.app) : undefined })).catch(() => null);
              res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify(out || { note: "That didn't work." }));
            });
            return;
          }
        }
        res.writeHead(404); res.end();
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}/${secret}/`;
      return base;
    },
    stop() {
      for (const c of clients) c.end();
      clients.clear();
      server?.close();
      server = null; base = null;
    },
    push(item) {
      items.push(item);
      while (items.length > KEEP) items.shift();
      const line = `event: item\ndata: ${JSON.stringify(pub(item))}\n\n`;
      for (const c of clients) c.write(line);
    },
    remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return false;
      items.splice(i, 1);
      const line = `event: gone\ndata: ${JSON.stringify({ id })}\n\n`;
      for (const c of clients) c.write(line);
      return true;
    },
    // Tell the page to close itself (voice "close the stage").
    bye() { for (const c of clients) c.write('event: bye\ndata: {}\n\n'); },
    viewers: () => clients.size,
    items: () => items,
  };
  return stage;
}
