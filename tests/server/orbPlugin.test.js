import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PluginHost } from '../../server/plugins/host.js';
import { createOrbPlugin } from '../../plugins/orb/index.js';
import { createOrbProcess } from '../../plugins/orb/orbProcess.js';

// The desktop orb (user, 2026-10-18): always on top in a corner, shows what Novi is doing, a tap
// talks to Novi, holding Ctrl+Shift+Space dictates into the app in front.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  child.stdin.on('data', (d) => child.written.push(...String(d).trim().split('\n').map((l) => JSON.parse(l))));
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('orb process (PowerShell window)', () => {
  it('starts hidden PowerShell in STA with the saved place, reads events, sends states, restarts after a crash', async () => {
    const spawned = [];
    const events = [];
    const timers = [];
    const proc = createOrbProcess({
      spawn: (cmd, args, opts) => { const c = fakeChild(); spawned.push({ cmd, args, opts, c }); return c; },
      script: 'C:\\novi\\orb.ps1', place: () => ({ x: 10, y: 20 }), onEvent: (e) => events.push(e),
      setTimeout: (fn, ms) => timers.push({ fn, ms }), logger: { warn() {} },
    });
    proc.start();
    const [{ cmd, args, opts, c }] = spawned;
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', 'C:\\novi\\orb.ps1', '-X', '10', '-Y', '20']);
    expect(opts.windowsHide).toBe(true);
    c.stdout.write('{"event":"tap"}\nnot json\n{"event":"moved","x":5,"y":6}\n');
    await tick();
    expect(events).toEqual([{ event: 'tap' }, { event: 'moved', x: 5, y: 6 }]);
    proc.send({ state: 'thinking' });
    await tick();
    expect(c.written).toEqual([{ state: 'thinking' }]);
    c.emit('exit', 1);
    expect(timers[0].ms).toBe(2000);
    timers[0].fn();
    expect(spawned).toHaveLength(2);
    proc.stop();
    expect(spawned[1].c.killed).toBe(true);
    expect(timers).toHaveLength(1); // stopped on purpose: no restart
  });
});

describe('orb plugin', () => {
  function setup({ platform = 'win32', env = {}, wav = Buffer.from('wav'), heard = 'see you at 5' } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-orb-'));
    const did = [];
    let onState = null;
    const sent = [];
    let handlers = null;
    const fakeProc = (opts) => { handlers = opts; return { start: () => did.push('start'), stop: () => did.push('stop'), send: (m) => sent.push(m) }; };
    const runtime = {
      dataDir,
      laptopState: { on: (fn) => { onState = fn; fn('idle'); return () => {}; } },
      wake: { listen: () => did.push('listen'), hold: (o) => did.push(['hold', o]), release: () => wav },
      hear: async () => heard,
      callTool: async (name, p) => { did.push([name, p]); return { note: 'Typed into Notepad.' }; },
      openUrl: async (u) => did.push(['open', u]),
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    let clock = 0; // each look at the clock is a second later: a hold, not a tap
    expect(host.register(createOrbPlugin({ platform, env, createProcess: fakeProc, now: () => (clock += 1000) }))).toBe(true);
    return { host, did, sent, dataDir, fire: (e) => handlers.onEvent(e), state: (s) => onState(s), handlers: () => handlers };
  }
  const startServices = (host) => host.startServices();

  it('on Windows: shows Novi\'s state; a tap listens; holding the keys dictates; a move is remembered', async () => {
    const t = setup();
    await startServices(t.host);
    expect(t.did).toEqual(['start']);
    expect(t.sent).toEqual([{ state: 'idle' }]);
    t.state('thinking');
    expect(t.sent.at(-1)).toEqual({ state: 'thinking' });
    t.fire({ event: 'tap' });
    expect(t.did.at(-1)).toBe('listen');
    t.fire({ event: 'hold_start' });
    expect(t.did.at(-1)).toEqual(['hold', { maxMs: 300_000 }]);
    await t.fire({ event: 'hold_end' });
    expect(t.did.at(-1)).toEqual(['dictate_type', { text: 'See you at 5' }]); // tidied: capital letter
    t.fire({ event: 'moved', x: 100, y: 200 });
    expect(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'orb.json'), 'utf8'))).toEqual({ x: 100, y: 200 });
    expect(t.handlers().place()).toEqual({ x: 100, y: 200 });
    t.fire({ event: 'open' });
    expect(t.did.at(-1)).toEqual(['open', 'https://localhost:3001']);
  });

  it('held-key dictation is tidied (fillers, stutters), or typed exactly as heard with NOVI_DICTATION_CLEANUP=off (2026-11-03)', async () => {
    const tidy = setup({ heard: 'um so i think the the plan is fine' });
    await startServices(tidy.host);
    await tidy.fire({ event: 'hold_end' });
    expect(tidy.did.at(-1)).toEqual(['dictate_type', { text: 'So I think the plan is fine' }]);
    const raw = setup({ heard: 'um so i think the the plan is fine', env: { NOVI_DICTATION_CLEANUP: 'off' } });
    await startServices(raw.host);
    await raw.fire({ event: 'hold_end' });
    expect(raw.did.at(-1)).toEqual(['dictate_type', { text: 'um so i think the the plan is fine' }]);
    const onlyFiller = setup({ heard: 'um' });
    await startServices(onlyFiller.host);
    await onlyFiller.fire({ event: 'hold_end' });
    expect(onlyFiller.did.some((d) => Array.isArray(d) && d[0] === 'dictate_type')).toBe(false);
  });

  it('a too-short hold or nothing heard types nothing; off on other systems or with NOVI_ORB=off', async () => {
    const short = setup({ wav: null });
    await startServices(short.host);
    await short.fire({ event: 'hold_end' });
    expect(short.did.some((d) => Array.isArray(d) && d[0] === 'dictate_type')).toBe(false);
    const silent = setup({ heard: '.' });
    await startServices(silent.host);
    await silent.fire({ event: 'hold_end' });
    expect(silent.did.some((d) => Array.isArray(d) && d[0] === 'dictate_type')).toBe(false);
    for (const t of [setup({ platform: 'linux' }), setup({ env: { NOVI_ORB: 'off' } })]) {
      await startServices(t.host);
      expect(t.did).toEqual([]);
    }
  });

  it('orb.ps1: on top, never takes the focus, Ctrl+Shift+Space held, never sends keys to apps', () => {
    const ps = fs.readFileSync(new URL('../../plugins/orb/orb.ps1', import.meta.url), 'utf8');
    expect(ps).toMatch(/Topmost\s*=\s*\$true/);
    expect(ps).toMatch(/0x08000000/); // WS_EX_NOACTIVATE
    expect(ps).toMatch(/GetAsyncKeyState\(0x11\)[\s\S]*GetAsyncKeyState\(0x10\)[\s\S]*GetAsyncKeyState\(0x20\)/);
    expect(ps).not.toMatch(/SendKeys|keybd_event|SendInput/);
    for (const e of ['tap', 'hold_start', 'hold_end', 'moved', 'open']) expect(ps).toContain(`'${e}'`);
  });
});

describe('held-key dictation live (2026-11-04: "the cursor moves, nothing gets typed")', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  it('the keys are taken from the app in front, and letting go means all three are up', () => {
    const ps = read('../../plugins/orb/orb.ps1');
    expect(ps).toMatch(/RegisterHotKey\(\[IntPtr\]::Zero, 1, 0x4006, 0x20\)/); // Ctrl+Shift+Space no longer types spaces
    expect(ps).toMatch(/\$anyDown/);
    expect(ps).toMatch(/-not \$anyDown -and \$script:held/); // never Ctrl+V with Ctrl+Shift still held
  });
  it('bringing a window forward never taps Alt (Notepad goes into menu mode and the paste is lost)', () => {
    const ps = read('../../plugins/laptop-control/control.ps1');
    const focus = /public static void Focus\(long id\) \{[\s\S]*?\n  \}/.exec(ps)[0];
    expect(focus).not.toMatch(/0x12/);
    expect(focus).toMatch(/AttachThreadInput/);
  });
  it('words that could not be typed are said, not lost', async () => {
    const said = [];
    let fire = null;
    const runtime = {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'novi-orb-')), wake: { release: () => Buffer.from('wav') }, hear: async () => 'hello',
      callTool: async () => ({ error: "I don't see a window for that." }),
      say: (text) => said.push(text),
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    host.register(createOrbPlugin({ platform: 'win32', env: {}, createProcess: (o) => { fire = o.onEvent; return { start() {}, stop() {}, send() {} }; } }));
    await host.startServices();
    await fire({ event: 'hold_end' });
    expect(said).toEqual(["I couldn't type that: I don't see a window for that."]);
  });
});

describe('hands-free dictation: tap to start, tap to stop (2026-11-04)', () => {
  function make() {
    let clock = 1000;
    const timers = [];
    const did = [];
    let fire = null;
    const runtime = {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'novi-orb-')),
      wake: { hold: (o) => did.push(['hold', o.maxMs]), release: () => { did.push('release'); return Buffer.from('wav'); } },
      hear: async () => 'a long note',
      callTool: async (name, p) => { did.push(['type', p.text]); return {}; },
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    host.register(createOrbPlugin({
      platform: 'win32', env: {}, now: () => clock,
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (t) => { timers.splice(timers.indexOf(t), 1); },
      createProcess: (o) => { fire = o.onEvent; return { start() {}, stop() {}, send() {} }; },
    }));
    return { host, did, timers, fire: (event) => fire({ event }), pass: (ms) => { clock += ms; } };
  }
  const press = async (s, ms) => { await s.fire('hold_start'); s.pass(ms); await s.fire('hold_end'); };

  it('a quick tap keeps listening with the keys up; the next tap stops and types, once', async () => {
    const s = make();
    await s.host.startServices();
    await press(s, 150);
    expect(s.did).toEqual([['hold', 300000]]); // still recording, nothing typed
    s.pass(60000); // a long pause in the middle changes nothing
    await press(s, 150);
    expect(s.did).toEqual([['hold', 300000], 'release', ['type', 'A long note']]);
    expect(s.timers).toEqual([]);
  });

  it('holding the keys is the same as before: letting go types at once', async () => {
    const s = make();
    await s.host.startServices();
    await press(s, 2000);
    expect(s.did).toEqual([['hold', 300000], 'release', ['type', 'A long note']]);
  });

  it('forgotten: it stops by itself at 5 minutes and still types', async () => {
    const s = make();
    await s.host.startServices();
    await press(s, 150);
    expect(s.timers[0].ms).toBe(300000);
    await s.timers[0].fn();
    expect(s.did.at(-1)).toEqual(['type', 'A long note']);
    await press(s, 150); // the next tap starts afresh
    expect(s.did.at(-1)).toEqual(['hold', 300000]);
  });

  it('the orb tells you about the tap', () => {
    expect(fs.readFileSync(new URL('../../plugins/orb/orb.ps1', import.meta.url), 'utf8')).toMatch(/tap .* to start and stop/i);
  });
});

describe('polish with the local AI (2026-11-04)', () => {
  function make({ polish, rewrite = async (p) => ({ text: `AI: ${p.text}` }) } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-orb-'));
    if (polish !== undefined) fs.writeFileSync(path.join(dataDir, 'dictation.json'), JSON.stringify({ polish }));
    const did = [];
    let fire = null;
    const runtime = {
      dataDir, wake: { hold() {}, release: () => Buffer.from('wav') }, hear: async () => 'um hello',
      callTool: async (name, p) => { did.push([name, p]); return name === 'text_rewrite' ? (p.warm ? {} : rewrite(p)) : {}; },
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    let clock = 0;
    host.register(createOrbPlugin({ platform: 'win32', env: {}, now: () => (clock += 1000), createProcess: (o) => { fire = o.onEvent; return { start() {}, stop() {}, send() {} }; } }));
    return { host, did, fire: (event) => fire({ event }) };
  }
  it('off by default: no model, no wait', async () => {
    const s = make();
    await s.host.startServices();
    await s.fire('hold_start');
    await s.fire('hold_end');
    expect(s.did).toEqual([['dictate_type', { text: 'Hello' }]]);
  });
  it('on: the model loads while you talk, and the polished words are typed', async () => {
    const s = make({ polish: true });
    await s.host.startServices();
    await s.fire('hold_start');
    expect(s.did).toEqual([['text_rewrite', { warm: true }]]);
    await s.fire('hold_end');
    expect(s.did.slice(1)).toEqual([['text_rewrite', { text: 'Hello' }], ['dictate_type', { text: 'AI: Hello' }]]);
  });
  it('the switch is saved with the clean-up one, and a failed rewrite still types', async () => {
    const s = make({ polish: true, rewrite: async () => { throw new Error('no model'); } });
    await s.host.startServices();
    await s.fire('hold_start');
    await s.fire('hold_end');
    expect(s.did.at(-1)).toEqual(['dictate_type', { text: 'Hello' }]);
    expect(await s.host.route('dictation-cleanup')({ polish: false })).toEqual({ on: true, polish: false, tone: false });
    expect(await s.host.route('dictation-cleanup')({ on: false })).toEqual({ on: false, polish: false, tone: false });
  });
});

describe('Settings: clean up dictation (2026-11-04)', () => {
  it('the setting turns the tidying off and on, is remembered, and starts from NOVI_DICTATION_CLEANUP', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-orb-'));
    const make = (env = {}) => {
      const did = [];
      let fire = null;
      const runtime = {
        dataDir, wake: { release: () => Buffer.from('wav') }, hear: async () => 'um hello',
        callTool: async (name, p) => { did.push(p.text); return {}; },
      };
      const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
      host.register(createOrbPlugin({ platform: 'win32', env, createProcess: (o) => { fire = o.onEvent; return { start() {}, stop() {}, send() {} }; } }));
      return { host, did, fire: async () => { await host.startServices(); await fire({ event: 'hold_end' }); } };
    };
    const a = make();
    const route = a.host.route('dictation-cleanup');
    expect(await route({})).toMatchObject({ on: true });
    expect(await route({ on: false })).toMatchObject({ on: false });
    await a.fire();
    expect(a.did).toEqual(['um hello']);
    const b = make();
    expect(await b.host.route('dictation-cleanup')({})).toMatchObject({ on: false }); // remembered
    expect(await b.host.route('dictation-cleanup')({ on: true })).toMatchObject({ on: true });
    await b.fire();
    expect(b.did).toEqual(['Hello']);
    fs.rmSync(path.join(dataDir, 'dictation.json'));
    expect(await make({ NOVI_DICTATION_CLEANUP: 'off' }).host.route('dictation-cleanup')({})).toMatchObject({ on: false });
  });
});
