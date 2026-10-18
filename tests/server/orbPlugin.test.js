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
    expect(host.register(createOrbPlugin({ platform, env, createProcess: fakeProc }))).toBe(true);
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
    expect(t.did.at(-1)).toEqual(['hold', { maxMs: 60_000 }]);
    await t.fire({ event: 'hold_end' });
    expect(t.did.at(-1)).toEqual(['dictate_type', { text: 'see you at 5' }]);
    t.fire({ event: 'moved', x: 100, y: 200 });
    expect(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'orb.json'), 'utf8'))).toEqual({ x: 100, y: 200 });
    expect(t.handlers().place()).toEqual({ x: 100, y: 200 });
    t.fire({ event: 'open' });
    expect(t.did.at(-1)).toEqual(['open', 'https://localhost:3001']);
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
