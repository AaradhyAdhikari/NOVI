import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSites } from '../../plugins/preview/sites.js';

const devServer = fileURLToPath(new URL('../fixtures/fake-dev-server.mjs', import.meta.url));
const cmd = (arg = '') => `"${process.execPath}" "${devServer}" ${arg}`.trim();
const project = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-site-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return d;
};
let sites;
afterEach(() => sites?.stopAll());
const get = async (port, p = '/') => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.text() }; };

describe('preview: running sites', () => {
  it('serves plain HTML files and refuses paths outside the folder', async () => {
    sites = createSites();
    const d = project({ 'index.html': '<h1>Home</h1>', 'about.html': 'About' });
    fs.writeFileSync(path.join(path.dirname(d), 'secret.txt'), 'no');
    const { port } = await sites.start('site', d);
    expect(await get(port)).toEqual({ status: 200, body: '<h1>Home</h1>' });
    expect((await get(port, '/about.html')).body).toBe('About');
    expect((await get(port, '/%2e%2e/secret.txt')).status).toBe(404);
  });

  it('runs the command and uses the port it prints (not the one in run.json)', async () => {
    let spawns = 0;
    sites = createSites({ spawnImpl: (...a) => { spawns += 1; return spawn(...a); } });
    const d = project({ '.novi/run.json': { command: cmd(), port: 5173, pages: { contact: '/contact' } } });
    const first = await sites.start('portfolio', d);
    expect(first.port).not.toBe(5173);
    expect(first.pages).toEqual({ contact: '/contact' });
    expect((await get(first.port, '/contact')).body).toBe('fake site /contact');
    expect(await sites.start('portfolio', d)).toMatchObject({ port: first.port });
    expect(spawns).toBe(1);
  });

  it('starts again after the site stopped by itself', async () => {
    let spawns = 0;
    sites = createSites({ spawnImpl: (...a) => { spawns += 1; return spawn(...a); } });
    const d = project({ '.novi/run.json': { command: cmd('quit') } });
    await sites.start('p', d);
    await new Promise((r) => setTimeout(r, 800));
    expect(sites.running('p')).toBe(false);
    await sites.start('p', d);
    expect(spawns).toBe(2);
  });

  it('a site that fails says why; one that never says its address times out', async () => {
    sites = createSites({ waitMs: 1500 });
    await expect(sites.start('a', project({ '.novi/run.json': { command: cmd('crash') } }))).rejects.toThrow("The site didn't start: Error: Cannot find module 'vite'");
    await expect(sites.start('b', project({ '.novi/run.json': { command: `"${process.execPath}" -e "setTimeout(()=>{},5000)"` } }))).rejects.toThrow("The site didn't say which address it uses.");
  });

  it('a port that something else already answers on is not "our site": a command that dies fails', async () => {
    const other = (await import('node:http')).createServer((q, r) => r.end('someone else')).listen(0, '127.0.0.1');
    await new Promise((r) => other.once('listening', r));
    const busy = other.address().port;
    sites = createSites({ waitMs: 4000 });
    const dies = `"${process.execPath}" -e "setTimeout(()=>{console.error('Error: listen EADDRINUSE: address already in use :::${busy}');process.exit(1)},800)"`;
    await expect(sites.start('p', project({ '.novi/run.json': { command: dies, port: busy } }))).rejects.toThrow(/EADDRINUSE/);
    other.close();
  });

  it('lists the sites that are running', async () => {
    sites = createSites();
    await sites.start('site', project({ 'index.html': 'x' }));
    expect(sites.list()).toEqual(['site']);
    sites.stop('site');
    expect(sites.list()).toEqual([]);
  });

  it('stop and stopAll end the sites', async () => {
    sites = createSites();
    const d = project({ '.novi/run.json': { command: cmd() } });
    const { port } = await sites.start('p', d);
    sites.stopAll();
    expect(sites.running('p')).toBe(false);
    // The process can take a moment to go on a busy laptop: wait (≤ 5 s) until the port stops answering.
    let answered = true;
    for (const end = Date.now() + 5000; answered && Date.now() < end;) {
      answered = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
      if (answered) await new Promise((r) => setTimeout(r, 200));
    }
    expect(answered).toBe(false);
  });
});
