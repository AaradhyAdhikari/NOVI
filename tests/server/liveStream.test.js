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
  it('a capture error from the page fails the start and closes everything', async () => {
    const e = fakeEdge({ reply: (expr, cdp) => { if (expr === 'start()') cdp.fire({ type: 'error', message: 'NotAllowedError' }); } });
    await expect(createStream(e.deps).start()).rejects.toThrow(/NotAllowedError/);
    expect(e.log).toContainEqual(['edge closed']);
    expect(e.log).toContainEqual(['server closed']);
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
    expect(s.made).toHaveLength(0);
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
