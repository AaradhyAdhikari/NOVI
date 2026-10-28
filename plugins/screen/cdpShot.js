// A phone picture of a page in real phone mode: hidden Edge driven over the DevTools protocol (CDP), so
// the page lays itself out for a 390 px phone. Live (2026-10-28): plain --window-size can't go below
// 496 px, so the tip calculator was laid out for 496 px and cropped to 390 — its right side was missing.
// The picture is sharp (2x), the whole width, and the page down to 3 screens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import WebSocket from 'ws';

const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hidden Edge with a DevTools port (its own empty profile, not signed in anywhere) → its page's socket.
export async function launchEdge({ retry = false, edge = EDGE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-phone-'));
  const profile = path.join(dir, 'profile');
  const child = spawn(edge, [
    '--headless=new', '--do-not-de-elevate', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    ...(retry ? ['--force-prefers-reduced-motion'] : ['--disable-gpu']),
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  const close = () => {
    // Edge's helper processes: the whole tree goes.
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
    setTimeout(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {}), 1000).unref?.();
  };
  try {
    let port = null;
    for (let waited = 0; waited < 15_000 && !port; waited += 200) {
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null; } catch { /* not yet */ }
      if (!port) await sleep(200);
    }
    if (!port) throw new Error("Edge didn't start for the picture.");
    let page = null;
    for (let waited = 0; waited < 5_000 && !page; waited += 200) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not yet */ }
      if (!page) await sleep(200);
    }
    if (!page) throw new Error("Edge didn't open a page for the picture.");
    return { wsUrl: page.webSocketDebuggerUrl, close };
  } catch (err) {
    close();
    throw err;
  }
}

// Also used by plugins/donecheck (its hidden test page).
export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const waiting = new Map();
    const listeners = new Map();
    let next = 1;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.id && waiting.has(msg.id)) {
        const { ok, fail } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message || 'DevTools error')); else ok(msg.result || {});
      } else if (msg.method) listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      send: (method, params = {}) => new Promise((ok, fail) => {
        const id = next++;
        waiting.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      on: (method, fn) => { listeners.set(method, [...(listeners.get(method) || []), fn]); },
      once: (method, ms) => new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`${method} timed out`)), ms);
        listeners.set(method, [...(listeners.get(method) || []), (p) => { clearTimeout(timer); ok(p); }]);
      }),
      close: () => ws.close(),
    }));
  });
}

export async function cdpShot(url, { width = 390, height = 844, scale = 2, screens = 3, retry = false, settleMs = retry ? 4000 : 1500, loadMs = 20_000, launch = launchEdge } = {}) {
  const edge = await launch({ retry });
  let cdp = null;
  try {
    cdp = await connect(edge.wsUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: true });
    await cdp.send('Page.enable');
    const loaded = cdp.once('Page.loadEventFired', loadMs);
    await cdp.send('Page.navigate', { url });
    await loaded.catch(() => {}); // a page that never says "loaded": take what is there
    if (settleMs) await sleep(settleMs); // fonts, first paint, short fade-ins
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const content = Math.ceil((metrics.cssContentSize || metrics.contentSize || {}).height || height);
    const shotHeight = Math.min(Math.max(content, height), height * screens);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: shotHeight, scale: 1 } });
    return Buffer.from(data, 'base64');
  } finally {
    cdp?.close();
    edge.close();
  }
}
