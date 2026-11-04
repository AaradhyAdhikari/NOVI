import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createLiveScreenPlugin } from '../../plugins/live-screen/index.js';
import { isLiveStart } from '../../server/brain/screenModeCommand.js';
import { tapPoint, scrollNotches } from '../../src/lib/liveInput.js';

const PHONE = { deviceId: 'phone-1' };

function setup({ asker = PHONE, frames = ['A'], focused = {} } = {}) {
  const did = [];
  const sent = [];
  let at = 1000;
  let n = 0;
  const driver = {
    screenshot: async () => { const f = frames[Math.min(n++, frames.length - 1)]; return { png: Buffer.from(f), width: 1920, height: 1200 }; },
    focused: async () => focused,
    click: async (x, y) => did.push(['click', x, y]),
    scroll: async (s) => did.push(['scroll', s]),
    type: async (t) => did.push(['type', t]),
    key: async (k) => did.push(['key', k]),
  };
  const runtime = { sendToDevice: (id, m) => sent.push([id, m]) };
  const host = new PluginHost({ runtime, env: {}, logger: { warn() {}, info() {} } });
  expect(host.register(createLiveScreenPlugin({ driver, now: () => at, gapMs: 0, idleMs: 60_000 }))).toBe(true);
  const say = async (msg, from = PHONE) => { const out = []; await host.runtime.liveMessage(msg, from, (m) => out.push(m)); return out; };
  return { host, did, sent, say, open: async (from = asker) => { await host.get('live_screen_open').gate({}, { from }); return host.get('live_screen_open').run({}); }, tick: (ms) => { at += ms; } };
}

describe('live screen words', () => {
  it('knows how it is asked for', () => {
    for (const t of ['open live screen', 'Live screen.', 'control my laptop', 'control my laptop from my phone', 'show my laptop live', 'laptop live dikhao', 'remote control my laptop']) expect(isLiveStart(t), t).toBe(true);
    for (const t of ['show me my screen', 'open chrome', 'control the volume']) expect(isLiveStart(t), t).toBe(false);
  });
});

describe('live screen on the phone', () => {
  it('asks for the PIN from a phone, every time, and can never be always-allowed', async () => {
    const s = setup();
    const gate = await s.host.get('live_screen_open').gate({}, { from: PHONE, direct: true });
    expect(gate.approval.pin).toBe(true);
    expect(gate.approval.grantable).toBe(false);
  });

  it('only opens on a phone, and tells that phone to show it', async () => {
    const laptop = setup({ asker: 'local' });
    expect((await laptop.open()).error).toMatch(/phone/);
    const s = setup();
    expect((await s.open()).note).toMatch(/laptop screen/);
    expect(s.sent).toEqual([['phone-1', { type: 'live_open' }]]);
  });

  it('belongs to the phone that gave the PIN, whoever spoke last; no gate, no session', async () => {
    const s = setup();
    expect((await s.host.get('live_screen_open').run({})).error).toBeTruthy();
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_closed');
    await s.open({ deviceId: 'phone-2' });
    expect((await s.say({ type: 'live_ack' }, { deviceId: 'phone-2' }))[0].type).toBe('live_frame');
    expect((await s.say({ type: 'live_ack' }, PHONE))[0].type).toBe('live_closed');
  });

  it('never types into a password box', async () => {
    const s = setup({ focused: { password: true } });
    await s.open();
    const out = await s.say({ type: 'live_input', kind: 'text', text: 'hunter2' });
    expect(s.did).toEqual([]);
    expect(out[0]).toMatchObject({ type: 'live_note' });
  });

  it('sends a picture when asked, and skips one that has not changed', async () => {
    const s = setup({ frames: ['A', 'A', 'B'] });
    await s.open();
    const [first] = await s.say({ type: 'live_ack' });
    expect(first).toMatchObject({ type: 'live_frame', width: 1920, height: 1200, png: Buffer.from('A').toString('base64') });
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_same');
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_frame');
  });

  it('a tap lands on the real pixel; scroll, words and keys go through', async () => {
    const s = setup();
    await s.open();
    await s.say({ type: 'live_ack' }); // a tap needs the screen's size from the first picture
    await s.say({ type: 'live_input', kind: 'tap', x: 0.5, y: 0.25 });
    await s.say({ type: 'live_input', kind: 'scroll', notches: -3 });
    await s.say({ type: 'live_input', kind: 'text', text: 'hello there' });
    await s.say({ type: 'live_input', kind: 'key', key: 'enter' });
    expect(s.did).toEqual([['click', 960, 300], ['scroll', -3], ['type', 'hello there'], ['key', 'enter']]);
  });

  it('bad input does nothing', async () => {
    const s = setup();
    await s.open();
    for (const m of [{ kind: 'tap', x: 2, y: 0.5 }, { kind: 'tap', x: 'a', y: 0 }, { kind: 'scroll', notches: 500 }, { kind: 'text', text: '' }, { kind: 'text', text: 'x'.repeat(3000) }, { kind: 'key', key: 'alt+f4' }, { kind: 'key', key: 'delete' }, { kind: 'nope' }]) {
      await s.say({ type: 'live_input', ...m });
    }
    expect(s.did).toEqual([]);
  });

  it('nothing works before it is opened, from another device, or from the laptop', async () => {
    const s = setup();
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_closed');
    await s.say({ type: 'live_input', kind: 'tap', x: 0.1, y: 0.1 });
    await s.open();
    expect((await s.say({ type: 'live_ack' }, { deviceId: 'someone-else' }))[0].type).toBe('live_closed');
    await s.say({ type: 'live_input', kind: 'tap', x: 0.1, y: 0.1 }, { deviceId: 'someone-else' });
    await s.say({ type: 'live_input', kind: 'tap', x: 0.1, y: 0.1 }, 'local');
    expect(s.did).toEqual([]);
  });

  it('closes when you close it, and by itself when left idle; then it needs the PIN again', async () => {
    const s = setup();
    await s.open();
    await s.say({ type: 'live_stop' });
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_closed');
    await s.open();
    s.tick(30_000);
    await s.say({ type: 'live_input', kind: 'tap', x: 0.1, y: 0.1 }); // a touch keeps it open
    s.tick(40_000);
    expect((await s.say({ type: 'live_ack' }))[0].type).toBe('live_frame'); // pictures alone don't…
    s.tick(25_000);
    const [closed] = await s.say({ type: 'live_ack' });
    expect(closed.type).toBe('live_closed');
    expect(closed.reason).toMatch(/idle/);
  });
});

describe('finger to laptop', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  it('turns a touch on the picture into a place on the screen, also when zoomed', () => {
    expect(tapPoint(rect, 200, 100)).toEqual({ x: 0.5, y: 0.5 });
    expect(tapPoint(rect, 100, 50)).toEqual({ x: 0, y: 0 });
  });
  it('a touch outside the picture is nothing', () => {
    expect(tapPoint(rect, 50, 100)).toBe(null);
    expect(tapPoint(rect, 200, 300)).toBe(null);
  });
  it('a finger moving up scrolls the page down', () => {
    expect(scrollNotches(-80)).toBe(-2);
    expect(scrollNotches(120)).toBe(3);
    expect(scrollNotches(10)).toBe(0);
    expect(scrollNotches(-5000)).toBe(-10);
  });
});
