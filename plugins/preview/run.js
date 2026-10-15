// How to run a project's website, without AI: Claude's .novi/run.json, else package.json
// (dev, then start), else a folder with index.html served as plain files.
import fs from 'node:fs';
import path from 'node:path';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

export function howToRun(dir) {
  const run = readJson(path.join(dir, '.novi', 'run.json'));
  if (run && typeof run.command === 'string' && run.command.trim()) {
    const port = Number(run.port);
    return { kind: 'command', command: run.command.trim(), port: Number.isInteger(port) && port > 0 ? port : null, pages: run.pages && typeof run.pages === 'object' ? run.pages : {} };
  }
  const scripts = readJson(path.join(dir, 'package.json'))?.scripts || {};
  if (scripts.dev) return { kind: 'command', command: 'npm run dev', port: null, pages: {} };
  if (scripts.start) return { kind: 'command', command: 'npm start', port: null, pages: {} };
  for (const sub of ['', 'public', 'dist']) {
    const root = sub ? path.join(dir, sub) : dir;
    if (fs.existsSync(path.join(root, 'index.html'))) return { kind: 'static', root, pages: {} };
  }
  return null;
}

// The port a dev server says it is on ("Local: http://localhost:5173/", "http://127.0.0.1:3000").
export function findPort(text) {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}
