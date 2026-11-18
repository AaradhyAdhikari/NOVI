// The phone card samples on http://localhost:3021, apart from Novi, for working on their look.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
// Only these two pages: the card samples and the gesture ideas.
const pages = { '/gestures.html': 'gestures.html' };
http.createServer((req, res) => {
  const page = path.join(dir, pages[(req.url || '/').split('?')[0]] || 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(page));
}).listen(3021, '127.0.0.1', () => console.log('Card samples: http://localhost:3021'));
