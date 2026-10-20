import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerReader } from '../../plugins/brain/reader.js';
import { createLagMeter } from '../../server/lag.js';
import { createBrainPlugin } from '../../plugins/brain/index.js';
import { PluginHost } from '../../server/plugins/host.js';

// Live 2026-10-20: typing or speaking to Novi took a while to show up. Reading big PDFs/Word files for the
// second brain ran on Novi's only thread and held everything else up; it now runs in a worker thread.
describe('brain file reader in a worker thread', () => {
  let reader;
  afterEach(() => reader?.close());

  it('reads a file off the main thread', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-rw-')), 'notes.md');
    fs.writeFileSync(f, '# DBMS\nNormal forms.');
    reader = createWorkerReader();
    expect(await reader.read(f)).toBe('# DBMS\nNormal forms.');
  });

  it('a file it cannot read is an error, and the next read still works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-rw-'));
    reader = createWorkerReader();
    await expect(reader.read(path.join(dir, 'gone.txt'))).rejects.toThrow();
    const ok = path.join(dir, 'ok.txt');
    fs.writeFileSync(ok, 'fine');
    expect(await reader.read(ok)).toBe('fine');
  });

  it('a read that hangs is given up after the time limit and the worker is replaced', async () => {
    reader = createWorkerReader({ timeoutMs: 200, script: new URL('../fixtures/hang-worker.mjs', import.meta.url) });
    await expect(reader.read('/x')).rejects.toThrow(/took too long/);
    expect(reader.restarts()).toBe(1);
  });
});

describe('lag meter', () => {
  it('reports how long Novi was blocked', async () => {
    const lag = createLagMeter({ resolutionMs: 10, logger: { warn() {} } });
    const until = Date.now() + 120;
    while (Date.now() < until) { /* block the thread */ }
    await new Promise((r) => setTimeout(r, 40));
    const s = lag.stats();
    expect(s.maxMs).toBeGreaterThanOrEqual(80);
    lag.stop();
  });
});

describe('brain pauses while you talk to Novi', () => {
  it('reads nothing while a request is running or just finished, then carries on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-bp-'));
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'hello world');
    let busy = true;
    const read = [];
    const runtime = {
      dataDir: path.join(dir, 'data'),
      busy: () => busy,
      fileEntries: () => [{ path: f, name: 'a', ext: '.txt', mtime: 1, dir: false }],
      readFileText: async (p) => { read.push(p); return 'hello world'; },
      projects: { list: () => [] },
      wikiNotes: () => [],
    };
    const host = new PluginHost({ runtime, logger: { warn() {}, info() {} } });
    const plugin = createBrainPlugin({ dbFile: ':memory:', autoStart: false, useWorker: false, quietMs: 0 });
    host.register(plugin);
    await runtime.brainSync({ respectBusy: true });
    expect(read).toEqual([]);
    busy = false;
    await runtime.brainSync({ respectBusy: true });
    expect(read).toEqual([f]);
  });
});
