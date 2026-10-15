// Runs coding projects' websites for previews: the project's own command (hidden, in the project
// folder, never elevated) or Novi serving plain HTML files. One site per project.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree } from '../../server/claude/session.js';
import { howToRun, findPort } from './run.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

function serveStatic(root) {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
    let file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(404).end('Not found'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The command runs through a shell: end the whole tree (taskkill /T on Windows; elsewhere the
// child is a process-group leader, so the group is killed).
function endTree(child) {
  if (process.platform === 'win32') return killTree(child.pid);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { killTree(child.pid); }
}

const accepts = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: 'localhost', autoSelectFamily: true }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

export function createSites({ spawnImpl = spawn, waitMs = 30_000 } = {}) {
  const sites = new Map(); // project → { port, pages, child?, server?, alive }

  function runCommand(project, dir, plan) {
    const child = spawnImpl(plan.command, { cwd: dir, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    const site = { child, pages: plan.pages, alive: true, port: null, lines };
    sites.set(project, site);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, port) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        if (err) { stop(project); reject(err); } else { site.port = port; resolve({ port, pages: plan.pages }); }
      };
      const onData = (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) lines.push(line.trim());
        lines.splice(0, Math.max(0, lines.length - 200));
        const port = findPort(String(chunk));
        if (port) finish(null, port);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', () => {
        site.alive = false;
        finish(new Error(`The site didn't start: ${lines.at(-1) || 'it stopped right away'}`));
      });
      child.on('error', (err) => finish(new Error(`The site didn't start: ${err.message}`)));
      // No address printed but run.json names a port: use it once it answers.
      const poll = setInterval(async () => { if (plan.port && await accepts(plan.port)) finish(null, plan.port); }, 500);
      const timer = setTimeout(() => finish(new Error("The site didn't say which address it uses.")), waitMs);
    });
  }

  function stop(project) {
    const site = sites.get(project);
    if (!site) return false;
    sites.delete(project);
    site.alive = false;
    if (site.child) endTree(site.child);
    site.server?.close();
    return true;
  }

  return {
    async start(project, dir, plan = howToRun(dir)) {
      const current = sites.get(project);
      if (current?.alive && current.port) return { port: current.port, pages: current.pages };
      if (current) stop(project);
      if (!plan) throw new Error("I don't know how to run this project yet.");
      if (plan.kind === 'static') {
        const server = await serveStatic(plan.root);
        const port = server.address().port;
        sites.set(project, { server, port, pages: plan.pages, alive: true });
        return { port, pages: plan.pages };
      }
      return runCommand(project, dir, plan);
    },
    stop,
    stopAll() { for (const project of [...sites.keys()]) stop(project); },
    running(project) { return Boolean(sites.get(project)?.alive); },
  };
}
