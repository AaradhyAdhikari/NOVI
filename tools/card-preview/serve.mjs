// The phone card samples on http://localhost:3021, apart from Novi, for working on their look.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(page));
}).listen(3021, '127.0.0.1', () => console.log('Card samples: http://localhost:3021'));
