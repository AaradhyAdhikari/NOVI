import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { cdpShot } from '../../plugins/screen/cdpShot.js';
import { pageShot } from '../../plugins/screen/pageShot.js';

// Live (2026-10-28): the tip calculator's phone picture was cut off on the right — hidden Edge can't make
// a window narrower than 496 px, so the page was laid out for 496 px and cropped to 390. Now a phone
// picture is taken in real phone mode over the DevTools protocol (a fake Edge here).
let server;
afterEach(() => server?.close());
function fakeEdge({ contentHeight = 1200, load = true } = {}) {
  const calls = [];
  let closed = false;
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (ws) => ws.on('message', (raw) => {
    const { id, method, params } = JSON.parse(raw);
    calls.push([method, params]);
    const reply = (result = {}) => ws.send(JSON.stringify({ id, result }));
    if (method === 'Page.navigate') { reply({ frameId: 'f' }); if (load) ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} })); return; }
    if (method === 'Page.getLayoutMetrics') return reply({ cssContentSize: { width: 390, height: contentHeight } });
    if (method === 'Page.captureScreenshot') return reply({ data: Buffer.from('PNGDATA').toString('base64') });
    return reply();
  }));
  const launch = async () => {
    if (!server.address()) await new Promise((r) => server.once('listening', r));
    return { wsUrl: `ws://127.0.0.1:${server.address().port}`, close: () => { closed = true; } };
  };
  return { calls, launch, closed: () => closed };
}

describe('phone pictures in real phone mode', () => {
  it('lays the page out as a 390 px phone (sharp, 2x) and takes the whole width and the page down to 3 screens', async () => {
    const edge = fakeEdge({ contentHeight: 1200 });
    const png = await cdpShot('http://127.0.0.1:5173/', { width: 390, height: 844, settleMs: 0, launch: edge.launch });
    expect(png.toString()).toBe('PNGDATA');
    const byName = Object.fromEntries(edge.calls.map(([m, p]) => [m, p]));
    expect(byName['Emulation.setDeviceMetricsOverride']).toEqual({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    expect(byName['Page.navigate']).toEqual({ url: 'http://127.0.0.1:5173/' });
    expect(byName['Page.captureScreenshot']).toEqual({ format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: 1200, scale: 1 } });
    expect(edge.calls.map(([m]) => m).indexOf('Emulation.setDeviceMetricsOverride')).toBeLessThan(edge.calls.map(([m]) => m).indexOf('Page.navigate'));
    expect(edge.closed()).toBe(true);
  });

  it('a short page is one screen; a very long one stops at 3 screens; no load event still gives a picture', async () => {
    const short = fakeEdge({ contentHeight: 300 });
    await cdpShot('http://x/', { width: 390, height: 844, settleMs: 0, launch: short.launch });
    expect(short.calls.find(([m]) => m === 'Page.captureScreenshot')[1].clip.height).toBe(844);
    server.close();
    const long = fakeEdge({ contentHeight: 9000, load: false });
    await cdpShot('http://x/', { width: 390, height: 844, settleMs: 0, loadMs: 50, launch: long.launch });
    expect(long.calls.find(([m]) => m === 'Page.captureScreenshot')[1].clip.height).toBe(844 * 3);
  });

  it('pageShot uses phone mode for phone-sized pictures, the plain window for wide ones', async () => {
    const used = [];
    const ok = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // not decodable → "not blank"
    await pageShot('http://x/', { width: 390, height: 844, phoneShoot: async () => { used.push('phone'); return ok; }, shoot: async () => { used.push('window'); return ok; } });
    await pageShot('http://x/', { width: 1280, height: 1400, phoneShoot: async () => { used.push('phone'); return ok; }, shoot: async () => { used.push('window'); return ok; } });
    expect(used).toEqual(['phone', 'window']);
  });
});
