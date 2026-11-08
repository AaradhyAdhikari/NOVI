// The laptop screen as smooth video for the phone (remote control step 1,
// docs/superpowers/plans/2026-11-08-novi-remote-control.md). Novi writes no capture code of its own: Windows
// Defender blocked win.ps1 when it gained screen capture + encoding (2026-11-04). Edge does it instead: a real
// Edge window parked off-screen (headless Edge only sees a fake 800x500 screen) runs getDisplayMedia with the
// screen picked by a switch, so no prompt shows, and sends it over WebRTC. Spike 2026-11-08: 1920x1200 at about
// 26 frames a second, no window on the taskbar, no sign-in pop-up with these switches.
// Setup (offer/answer) goes through Novi's own socket; Tailscale is the path, so no outside servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { connect as cdpConnect } from '../screen/cdpShot.js';

const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function edgeArgs({ profile, url, screen = 1 }) {
  return [
    '--window-position=-32000,-32000', '--window-size=320,240', `--app=${url}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--auto-select-desktop-capture-source=Screen ${screen}`, '--use-fake-ui-for-media-stream',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    // msImplicitSignin: a fresh profile showed "...has signed in on this device" over the screen.
    // WebRtcHideLocalIpsWithMdns: the phone must see the laptop's real Tailscale address.
    '--disable-features=msImplicitSignin,WebRtcHideLocalIpsWithMdns,msEdgeSidebarV2',
  ];
}

// The page in that Edge. start() is run by Novi "as a click" (getDisplayMedia needs one); everything it has to
// say goes out through the one binding noviSignal. Non-trickle: the offer waits for all its addresses.
export function senderPage() {
  return `<!doctype html><meta charset="utf-8"><title>Novi remote</title><script>
let pc = null;
const say = (m) => window.noviSignal(JSON.stringify(m));
window.start = async () => {
  try {
    const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    const track = media.getVideoTracks()[0];
    track.contentHint = 'detail'; // text stays sharp: this is for real work
    const { width = 0, height = 0 } = track.getSettings();
    pc = new RTCPeerConnection({ iceServers: [] });
    const sender = pc.addTransceiver(track, { direction: 'sendonly' }).sender;
    pc.onconnectionstatechange = () => say({ type: 'state', state: pc.connectionState });
    track.onended = () => say({ type: 'state', state: 'ended' });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 3000); });
    const p = sender.getParameters();
    if (p.encodings && p.encodings[0]) { p.encodings[0].maxBitrate = 8000000; p.encodings[0].maxFramerate = 30; }
    p.degradationPreference = 'maintain-resolution';
    await sender.setParameters(p).catch(() => {});
    say({ type: 'offer', sdp: pc.localDescription.sdp, width, height });
  } catch (e) { say({ type: 'error', message: String(e && (e.name || e.message) || e) }); }
};
window.fromPhone = async (m) => {
  try { if (m.type === 'answer' && pc) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); }
  catch (e) { say({ type: 'error', message: String(e && (e.name || e.message) || e) }); }
};
</script>`;
}

// A loopback server for that one page, at a random path.
async function serve() {
  const route = `/${crypto.randomBytes(12).toString('hex')}`;
  const page = senderPage();
  const server = http.createServer((req, res) => {
    if (req.url !== route) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}${route}`, close: () => server.close() };
}

async function launch({ url, screen = 1, edge = EDGE }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-remote-'));
  const profile = path.join(dir, 'profile');
  const child = spawn(edge, edgeArgs({ profile, url, screen }), { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  const close = () => {
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
    setTimeout(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {}), 1500).unref?.();
  };
  try {
    let port = null;
    for (let waited = 0; waited < 15_000 && !port; waited += 200) {
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null; } catch { /* not yet */ }
      if (!port) await sleep(200);
    }
    if (!port) throw new Error("Edge didn't start.");
    let page = null;
    for (let waited = 0; waited < 8_000 && !page; waited += 200) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url === url); } catch { /* not yet */ }
      if (!page) await sleep(200);
    }
    if (!page) throw new Error("Edge didn't open the screen page.");
    return { wsUrl: page.webSocketDebuggerUrl, close };
  } catch (err) {
    close();
    throw err;
  }
}

// One stream: start() → { sdp, width, height } (the offer for the phone), answer(sdp), stop().
export function createStream({ serve: serveImpl = serve, launch: launchImpl = launch, connect = cdpConnect, screen = 1, timeoutMs = 8_000, logger = null } = {}) {
  let server = null;
  let edge = null;
  let cdp = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { cdp?.close(); } catch { /* gone */ }
    edge?.close();
    server?.close();
  };
  return {
    async start() {
      try {
        server = await serveImpl();
        edge = await launchImpl({ url: server.url, screen });
        cdp = await connect(edge.wsUrl);
        const offer = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("The screen stream didn't start in time.")), timeoutMs);
          cdp.on('Runtime.bindingCalled', ({ name, payload }) => {
            if (name !== 'noviSignal') return;
            let m;
            try { m = JSON.parse(payload); } catch { return; }
            if (m.type === 'offer') { clearTimeout(timer); resolve({ sdp: String(m.sdp), width: Number(m.width) || 0, height: Number(m.height) || 0 }); }
            else if (m.type === 'error') { clearTimeout(timer); reject(new Error(`The screen capture failed: ${m.message}`)); }
            else if (m.type === 'state') logger?.info?.(`[live] stream ${m.state}`);
          });
        });
        // Anything the page throws is logged, so a stream that never starts says why.
        cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => logger?.warn?.(`[live] page error: ${String(d?.exception?.description || d?.text || '').slice(0, 200)}`));
        await cdp.send('Runtime.enable');
        await cdp.send('Runtime.addBinding', { name: 'noviSignal' });
        await cdp.send('Runtime.evaluate', { expression: 'start()', userGesture: true });
        return await offer;
      } catch (err) {
        stop();
        throw err;
      }
    },
    async answer(sdp) {
      if (stopped || !cdp) return;
      await cdp.send('Runtime.evaluate', { expression: `fromPhone(${JSON.stringify({ type: 'answer', sdp: String(sdp) })})` });
    },
    stop,
  };
}
