import { describe, it, expect } from 'vitest';
import { edgeArgs, senderPage, createStream } from '../../plugins/live-screen/stream.js';
import { PluginHost } from '../../server/plugins/host.js';
import { createLiveScreenPlugin } from '../../plugins/live-screen/index.js';

// Remote control step 1 (plan docs/superpowers/plans/2026-11-08-novi-remote-control.md): the laptop screen as
// smooth video. An Edge window off-screen captures the screen (spike 2026-11-08: 1920x1200 at ~26 fps, no prompt,
// nothing on the taskbar) and sends it to the phone over WebRTC; Novi's own socket carries the setup.

describe('the Edge that captures', () => {
  const args = edgeArgs({ profile: 'C:\\p', url: 'http://127.0.0.1:5/s' });
  it('is a real window off-screen (headless only sees a fake 800x500 screen) and picks the screen with no prompt', () => {
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false);
    expect(args).toContain('--window-position=-32000,-32000');
    expect(args).toContain('--app=http://127.0.0.1:5/s');
    expect(args).toContain('--auto-select-desktop-capture-source=Screen 1');
    expect(args).toContain('--use-fake-ui-for-media-stream');
    expect(args).toContain('--user-data-dir=C:\\p');
    // Novi may run as admin: Edge would restart itself unelevated and lose these switches (live 2026-11-08:
    // the stream worked from a plain script, never inside Novi).
    expect(args).toContain('--do-not-de-elevate');
  });
  it('keeps going while unseen, never signs in, and shows its real address to the phone', () => {
    for (const a of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-sync']) expect(args).toContain(a);
    const features = args.find((a) => a.startsWith('--disable-features='));
    expect(features).toMatch(/msImplicitSignin/);
    expect(features).toMatch(/WebRtcHideLocalIpsWithMdns/);
  });
  it('picks another monitor by its number', () => {
    expect(edgeArgs({ profile: 'p', url: 'u', screen: 2 })).toContain('--auto-select-desktop-capture-source=Screen 2');
  });
  it('the page sends video only, sharp text first, and reports through one binding', () => {
    const html = senderPage();
    expect(html).toMatch(/getDisplayMedia/);
    expect(html).toMatch(/audio: false/);
    expect(html).toMatch(/contentHint = 'detail'/);
    expect(html).toMatch(/noviSignal/);
    expect(html).toMatch(/iceServers: \[\]/); // Tailscale is the path: no outside servers
  });
});

function fakeEdge({ reply = (expr, cdp) => { if (expr === 'start()') cdp.fire({ type: 'offer', sdp: 'OFFER', width: 1920, height: 1200 }); } } = {}) {
  const log = [];
  let handler = null;
  const cdp = {
    fire: (msg) => setTimeout(() => handler?.({ name: 'noviSignal', payload: JSON.stringify(msg) }), 0),
    send: async (method, params = {}) => {
      log.push([method, params]);
      if (method === 'Runtime.evaluate' && params.expression === "typeof window.start === 'function'") return { result: { value: true } };
      if (method === 'Runtime.evaluate') reply(params.expression, cdp);
      return {};
    },
    on: (method, fn) => { if (method === 'Runtime.bindingCalled') handler = fn; },
    close: () => log.push(['cdp closed']),
  };
  const deps = {
    serve: async () => ({ url: 'http://127.0.0.1:9/s', close: () => log.push(['server closed']) }),
    launch: async ({ url }) => { log.push(['launch', url]); return { wsUrl: 'ws://x', close: () => log.push(['edge closed']) }; },
    connect: async () => cdp,
  };
  return { log, deps, cdp };
}

describe('one stream', () => {
  it('starts Edge, starts the capture as if clicked, and hands back the offer with the screen size', async () => {
    const e = fakeEdge();
    const stream = createStream(e.deps);
    expect(await stream.start()).toEqual({ sdp: 'OFFER', width: 1920, height: 1200 });
    expect(e.log).toContainEqual(['Runtime.addBinding', { name: 'noviSignal' }]);
    const start = e.log.find(([m, p]) => m === 'Runtime.evaluate' && p.expression === 'start()');
    expect(start[1].userGesture).toBe(true);
  });
  it('passes the phone answer in as data, never as code', async () => {
    const e = fakeEdge();
    const stream = createStream(e.deps);
    await stream.start();
    await stream.answer('v=0\r\n"); alert(1); ("');
    const call = e.log.filter(([m]) => m === 'Runtime.evaluate').at(-1)[1].expression;
    expect(call.startsWith('fromPhone(')).toBe(true);
    expect(call).toBe(`fromPhone(${JSON.stringify({ type: 'answer', sdp: 'v=0\r\n"); alert(1); ("' })})`);
  });
  // Live 2026-11-08: "stopped at: starting Edge" — start() was sent before the page had loaded, so it did nothing.
  it('waits until the page is ready before starting the capture', async () => {
    let checks = 0;
    const e = fakeEdge({ reply: (expr, cdp) => { if (expr === 'start()') cdp.fire({ type: 'offer', sdp: 'OFFER', width: 1, height: 1 }); } });
    const send = e.cdp.send;
    e.cdp.send = async (method, params = {}) => {
      if (method === 'Runtime.evaluate' && params.expression === "typeof window.start === 'function'") { checks += 1; return { result: { value: checks >= 3 } }; }
      return send(method, params);
    };
    await createStream({ ...e.deps, readyEveryMs: 1 }).start();
    expect(checks).toBe(3);
  });
  it('a capture error from the page fails the start and closes everything', async () => {
    const e = fakeEdge({ reply: (expr, cdp) => { if (expr === 'start()') cdp.fire({ type: 'error', message: 'NotAllowedError' }); } });
    await expect(createStream(e.deps).start()).rejects.toThrow(/NotAllowedError/);
    expect(e.log).toContainEqual(['edge closed']);
    expect(e.log).toContainEqual(['server closed']);
  });
  it('a stream that never gets its offer says how far the page got', async () => {
    const e = fakeEdge({ reply: (expr, cdp) => { if (expr === 'start()') cdp.fire({ type: 'stage', stage: 'asking for the screen' }); } });
    await expect(createStream({ ...e.deps, timeoutMs: 30 }).start()).rejects.toThrow(/asking for the screen/);
  });
  it('no offer in time fails and closes', async () => {
    const e = fakeEdge({ reply: () => {} });
    await expect(createStream({ ...e.deps, timeoutMs: 20 }).start()).rejects.toThrow(/didn't start/);
    expect(e.log).toContainEqual(['edge closed']);
  });
  it('stop closes Edge, the page link and the little server, once', async () => {
    const e = fakeEdge();
    const stream = createStream(e.deps);
    await stream.start();
    stream.stop();
    stream.stop();
    expect(e.log.filter(([m]) => m === 'edge closed')).toHaveLength(1);
    expect(e.log).toContainEqual(['cdp closed']);
    expect(e.log).toContainEqual(['server closed']);
  });
});

const PHONE = { deviceId: 'phone-1' };
function setup({ fail = false } = {}) {
  const made = [];
  const sent = [];
  const did = [];
  const stream = () => {
    const s = { answers: [], stopped: 0 };
    made.push(s);
    return {
      start: async () => { if (fail) throw new Error('no capture'); return { sdp: 'OFFER', width: 1920, height: 1200 }; },
      answer: async (sdp) => { s.answers.push(sdp); },
      stop: () => { s.stopped += 1; },
    };
  };
  const driver = { screenshot: async () => ({ png: Buffer.from('A'), width: 1920, height: 1200 }), click: async (x, y) => did.push(['click', x, y]), scroll: async (n, at) => did.push(['scroll', n, at]) };
  const host = new PluginHost({ runtime: { sendToDevice: (id, m) => sent.push([id, m]) }, env: {}, logger: { warn() {}, info() {} } });
  host.register(createLiveScreenPlugin({ driver, stream, gapMs: 0 }));
  const say = async (msg, from = PHONE) => { const out = []; await host.runtime.liveMessage(msg, from, (m) => out.push(m)); return out; };
  const open = async () => { await host.get('live_screen_open').gate({}, { from: PHONE }); return host.get('live_screen_open').run({}); };
  return { host, made, sent, did, say, open };
}

describe('Live screen with the video stream', () => {
  it('the owner phone gets the offer; its answer goes to the stream', async () => {
    const s = setup();
    await s.open();
    expect(await s.say({ type: 'live_stream' })).toEqual([{ type: 'live_offer', sdp: 'OFFER', width: 1920, height: 1200 }]);
    await s.say({ type: 'live_answer', sdp: 'ANSWER' });
    expect(s.made[0].answers).toEqual(['ANSWER']);
  });
  it('another phone, or no session, gets nothing started', async () => {
    const s = setup();
    expect((await s.say({ type: 'live_stream' }))[0].type).toBe('live_closed');
    await s.open();
    expect((await s.say({ type: 'live_stream' }, { deviceId: 'phone-2' }))[0].type).toBe('live_closed');
    expect(s.made).toHaveLength(1); // only the one warmed up by the PIN card; the other phone started nothing
  });
  it('taps on the video land on the real screen size before any picture was sent', async () => {
    const s = setup();
    await s.open();
    await s.say({ type: 'live_stream' });
    await s.say({ type: 'live_input', kind: 'tap', x: 0.5, y: 0.25 });
    expect(s.did).toEqual([['click', 960, 300]]);
  });
  // Live 2026-11-08: a swipe over the browser pane scrolled the middle of the window instead.
  it('a swipe scrolls the part under the finger', async () => {
    const s = setup();
    await s.open();
    await s.say({ type: 'live_stream' });
    await s.say({ type: 'live_input', kind: 'scroll', notches: -2, x: 0.75, y: 0.5 });
    await s.say({ type: 'live_input', kind: 'scroll', notches: 1 });
    await s.say({ type: 'live_input', kind: 'scroll', notches: 1, x: 7, y: 0.5 });
    expect(s.did).toEqual([['scroll', -2, { x: 1440, y: 600 }], ['scroll', 1, undefined], ['scroll', 1, undefined]]);
  });
  it('a stream that fails says so, and the pictures still work as the backup', async () => {
    const s = setup({ fail: true });
    await s.open();
    expect(await s.say({ type: 'live_stream' })).toEqual([{ type: 'live_stream_failed' }]);
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_frame');
  });
  // Live 2026-11-08: two starts in a row timed out, the next one worked in 2 s.
  it('a start that fails is tried once more with a fresh Edge', async () => {
    let tries = 0;
    const made = [];
    const stream = () => ({ start: async () => { tries += 1; if (tries === 1) throw new Error('slow'); return { sdp: 'OFFER', width: 1920, height: 1200 }; }, answer: async () => {}, stop: () => made.push('stopped') });
    const host = new PluginHost({ runtime: { sendToDevice() {} }, env: {}, logger: { warn() {}, info() {} } });
    host.register(createLiveScreenPlugin({ driver: { screenshot: async () => ({ png: Buffer.from('A'), width: 1, height: 1 }) }, stream, gapMs: 0 }));
    await host.get('live_screen_open').gate({}, { from: PHONE });
    await host.get('live_screen_open').run({});
    const out = [];
    await host.runtime.liveMessage({ type: 'live_stream' }, PHONE, (m) => out.push(m));
    expect(tries).toBe(2);
    expect(out[0].type).toBe('live_offer');
  });
  it('a second start replaces the old stream; closing ends it', async () => {
    const s = setup();
    await s.open();
    await s.say({ type: 'live_stream' });
    await s.say({ type: 'live_stream' });
    expect(s.made[0].stopped).toBe(1);
    await s.say({ type: 'live_stop' });
    expect(s.made[1].stopped).toBe(1);
  });
});

import { answerOffer } from '../../src/lib/liveVideo.js';

describe('the phone answers the offer', () => {
  function FakePeer(config) {
    this.config = config; this.iceGatheringState = 'new'; this.log = [];
    this.setRemoteDescription = async (d) => { this.log.push(['remote', d]); };
    this.createAnswer = async () => ({ type: 'answer', sdp: 'ANSWER' });
    this.setLocalDescription = async (d) => { this.localDescription = d; setTimeout(() => { this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.(); }, 0); };
    FakePeer.last = this;
  }
  it('takes the offer, waits for its addresses, and gives back the answer; no outside servers', async () => {
    const out = await answerOffer('OFFER', { Peer: FakePeer });
    expect(out.sdp).toBe('ANSWER');
    expect(FakePeer.last.config).toEqual({ iceServers: [] });
    expect(FakePeer.last.log).toEqual([['remote', { type: 'offer', sdp: 'OFFER' }]]);
  });
  it('hands over the video and the link state', async () => {
    const got = [];
    await answerOffer('OFFER', { Peer: FakePeer, onTrack: (e) => got.push(['track', e.id]), onState: (s) => got.push(['state', s]) });
    FakePeer.last.ontrack({ id: 'v' });
    FakePeer.last.connectionState = 'connected';
    FakePeer.last.onconnectionstatechange();
    expect(got).toEqual([['track', 'v'], ['state', 'connected']]);
  });
});

import { trustedByPin } from '../../server/voice/heardFilter.js';

// User's choice (2026-11-08): the phone that opened the remote view with the PIN is trusted by voice while it
// watches (its voice scored 0.50-0.54 through the phone mic, under the pass mark). A strict card still checks.
describe('voice from the phone watching the remote view', () => {
  it('skips the voice check while it watches', () => {
    expect(trustedByPin([], true)).toBe(true);
    expect(trustedByPin([{ tier: 'medium' }], true)).toBe(true);
  });
  it('never for a phone that is not watching, or while a high-risk / PIN / delete card waits', () => {
    expect(trustedByPin([], false)).toBe(false);
    expect(trustedByPin([{ tier: 'high' }], true)).toBe(false);
    expect(trustedByPin([{ pin: true }], true)).toBe(false);
    expect(trustedByPin([{ kind: 'delete' }], true)).toBe(false);
  });
});

// User, 2026-11-08: "why is it taking so long to open the live screen … the fastest we can as we click".
// Edge starts warming up while the PIN card waits, so the video is (nearly) ready when the PIN is given.
describe('the video warms up during the PIN card', () => {
  function warm({ prewarmMs = 60_000 } = {}) {
    const made = [];
    const stream = () => {
      const s = { starts: 0, stopped: 0 };
      made.push(s);
      return { start: async () => { s.starts += 1; return { sdp: 'OFFER', width: 1920, height: 1200 }; }, answer: async () => {}, stop: () => { s.stopped += 1; } };
    };
    const host = new PluginHost({ runtime: { sendToDevice() {} }, env: {}, logger: { warn() {}, info() {} } });
    host.register(createLiveScreenPlugin({ driver: { screenshot: async () => ({ png: Buffer.from('A'), width: 1, height: 1 }) }, stream, gapMs: 0, prewarmMs }));
    const say = async (msg) => { const out = []; await host.runtime.liveMessage(msg, PHONE, (m) => out.push(m)); return out; };
    return { host, made, say };
  }
  it('the PIN card starts Edge; the view then uses that same start', async () => {
    const w = warm();
    await w.host.get('live_screen_open').gate({}, { from: PHONE });
    expect(w.made).toHaveLength(1);
    expect(w.made[0].starts).toBe(1);
    await w.host.get('live_screen_open').run({});
    expect(await w.say({ type: 'live_stream' })).toEqual([{ type: 'live_offer', sdp: 'OFFER', width: 1920, height: 1200 }]);
    expect(w.made).toHaveLength(1);
    expect(w.made[0].starts).toBe(1);
  });
  it('a card nobody approves stops the warm Edge', async () => {
    const w = warm({ prewarmMs: 20 });
    await w.host.get('live_screen_open').gate({}, { from: PHONE });
    await new Promise((r) => setTimeout(r, 60));
    expect(w.made[0].stopped).toBe(1);
  });
  it('asked again, the old warm Edge goes first', async () => {
    const w = warm();
    await w.host.get('live_screen_open').gate({}, { from: PHONE });
    await w.host.get('live_screen_open').gate({}, { from: PHONE });
    expect(w.made[0].stopped).toBe(1);
    expect(w.made).toHaveLength(2);
  });
});

import { boostAnswer } from '../../plugins/live-screen/stream.js';

// User, 2026-11-08: "the quality is bad … at least 2K". Measured: VP8 at 966 kbps (WebRTC starts low and
// creeps up). The phone's answer gets a floor and a start rate before it reaches the laptop's Edge, and the
// page prefers H.264 (encoded on the graphics chip).
describe('a sharp stream', () => {
  const ANSWER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 102\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n';
  it('every video codec gets start / floor / ceiling rates, and the line gets a bandwidth', () => {
    const out = boostAnswer(ANSWER);
    expect(out).toMatch(/a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=6000;x-google-min-bitrate=3000;x-google-max-bitrate=12000\r\n/);
    expect(out).toMatch(/a=fmtp:96 x-google-start-bitrate=6000;x-google-min-bitrate=3000;x-google-max-bitrate=12000\r\n/);
    expect(out).toMatch(/c=IN IP4 0\.0\.0\.0\r\nb=AS:12000\r\n/);
  });
  it('is done once only, and leaves an answer with no video alone', () => {
    expect(boostAnswer(boostAnswer(ANSWER))).toBe(boostAnswer(ANSWER));
    expect(boostAnswer('v=0\r\nm=audio 9 RTP 111\r\n')).toBe('v=0\r\nm=audio 9 RTP 111\r\n');
  });
  it('the page puts H.264 first', () => {
    expect(senderPage()).toMatch(/setCodecPreferences/);
    expect(senderPage()).toMatch(/video\/H264/);
  });
});

import { leftoverScript, hideScript, closeScript } from '../../plugins/live-screen/edgeCleanup.js';

// Live 2026-11-11: 8 stream Edges were left running (each Novi restart left one; Windows keeps a program's
// children alive) and showed up on the taskbar with Edge's warning bar. Leftovers are closed by Novi's own
// profile name (never the user's Edge), and the stream window is hidden.
describe('leftover stream Edges', () => {
  it('only Edges started with Novi\'s stream profile, never the user\'s, sparing the running one', () => {
    const s = leftoverScript(['novi-remote-Ab12']);
    expect(s).toMatch(/Name='msedge\.exe'/);
    expect(s).toMatch(/novi-remote-/);
    expect(s).toMatch(/-notmatch 'novi-remote-Ab12'/);
    expect(s).toMatch(/taskkill/);
  });
  // Live 2026-11-11: the Edge Novi starts hands off to another process and exits, so its process id missed;
  // each stream is found by its own profile folder name instead.
  it('hides and closes one stream by its profile folder name; nothing else gets in', () => {
    expect(hideScript('novi-remote-Ab12')).toMatch(/novi-remote-Ab12/);
    expect(hideScript('novi-remote-Ab12')).toMatch(/ShowWindow\(\$h, 0\)/);
    expect(closeScript('novi-remote-Ab12')).toMatch(/taskkill/);
    expect(() => hideScript("novi-remote-x'; rm")).toThrow();
    expect(() => closeScript('C:\\Users')).toThrow();
  });
  it('Novi closes leftovers when it starts', async () => {
    let cleaned = 0;
    const host = new PluginHost({ runtime: { sendToDevice() {} }, env: {}, logger: { warn() {}, info() {} } });
    host.register(createLiveScreenPlugin({ driver: {}, stream: () => ({}), cleanup: async () => { cleaned += 1; } }));
    await host.startServices?.();
    expect(cleaned).toBe(1);
  });
});

// Live 2026-11-11: the PIN-card warm-up started a REAL Edge in every test run (one test passed no stream), and
// each full run left more on the user's screen. Under the test runner the defaults never touch Edge.
describe('tests never start a real Edge', () => {
  it('the default stream and cleanup are inert under the test runner', async () => {
    const host = new PluginHost({ runtime: { sendToDevice() {} }, env: {}, logger: { warn() {}, info() {} } });
    host.register(createLiveScreenPlugin({ driver: { screenshot: async () => ({ png: Buffer.from('A'), width: 1, height: 1 }) }, gapMs: 0 }));
    await host.get('live_screen_open').gate({}, { from: PHONE });
    await host.get('live_screen_open').run({});
    const out = [];
    await host.runtime.liveMessage({ type: 'live_stream' }, PHONE, (m) => out.push(m));
    expect(out).toEqual([{ type: 'live_stream_failed' }]);
  });
});
