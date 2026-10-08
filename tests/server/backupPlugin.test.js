import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { createBackupPlugin, backupName } from '../../plugins/backup/index.js';

let root;
let dataDir;
let backupsDir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-backup-'));
  dataDir = path.join(root, 'data');
  backupsDir = path.join(root, 'backups');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'memory.json'), '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup({ now = () => new Date('2026-10-07T03:15:00'), existing = [], drive = null } = {}) {
  fs.mkdirSync(backupsDir, { recursive: true });
  for (const f of existing) fs.writeFileSync(path.join(backupsDir, f), 'old');
  const archived = [];
  const archive = async ({ from, to, exclude }) => { archived.push({ from, to, exclude }); fs.writeFileSync(to, 'zip'); };
  const host = new PluginHost({ runtime: { dataDir }, env: { NOVI_PLUGIN_BACKUP_DIR: backupsDir }, logger: { warn() {} } });
  expect(host.register(createBackupPlugin({ archive, now, intervalMs: 3_600_000, ...(drive ? { driveUploader: () => drive } : {}) }))).toBe(true);
  return { host, archived };
}

describe('backup plugin', () => {
  it('names backups by local date and time', () => {
    expect(backupName(new Date('2026-10-07T03:05:00'))).toBe('novi-data-2026-10-07-0305.zip');
  });

  it('backs up data/ (without logs) on request', async () => {
    const { host, archived } = setup();
    const out = await host.get('backup_now').run({});
    expect(archived).toEqual([{ from: dataDir, to: path.join(backupsDir, 'novi-data-2026-10-07-0315.zip'), exclude: ['logs'] }]);
    expect(out.file).toBe('novi-data-2026-10-07-0315.zip');
    expect(out.text).toMatch(/Backed up/);
  });

  it('keeps only the newest 14 backups', async () => {
    const existing = Array.from({ length: 15 }, (_, i) => `novi-data-2026-09-${String(i + 1).padStart(2, '0')}-0300.zip`);
    const { host } = setup({ existing });
    await host.get('backup_now').run({});
    const left = fs.readdirSync(backupsDir).sort();
    expect(left).toHaveLength(14);
    expect(left[0]).toBe('novi-data-2026-09-03-0300.zip');
    expect(left.at(-1)).toBe('novi-data-2026-10-07-0315.zip');
  });

  it('on start, backs up only when the newest backup is over a day old', async () => {
    const fresh = setup({ existing: ['novi-data-2026-10-07-0100.zip'] });
    fs.utimesSync(path.join(backupsDir, 'novi-data-2026-10-07-0100.zip'), new Date('2026-10-07T01:00:00'), new Date('2026-10-07T01:00:00'));
    await fresh.host.startServices();
    await fresh.host.stopServices();
    expect(fresh.archived).toEqual([]);

    fs.utimesSync(path.join(backupsDir, 'novi-data-2026-10-07-0100.zip'), new Date('2026-10-05T01:00:00'), new Date('2026-10-05T01:00:00'));
    const stale = setup();
    await stale.host.startServices();
    await stale.host.stopServices();
    expect(stale.archived).toHaveLength(1);
  });

  it('reports the latest backup', async () => {
    const { host } = setup({ existing: ['novi-data-2026-10-06-0300.zip'] });
    const out = await host.get('backup_status').run({});
    expect(out.latest).toBe('novi-data-2026-10-06-0300.zip');
    expect(out.count).toBe(1);
  });

  it('needs no approval', async () => {
    const { host } = setup();
    expect(await host.get('backup_now').gate({})).toEqual({});
  });
});

describe.skipIf(process.platform !== 'win32')('real zip on Windows', () => {
  it('zips a folder with a non-ASCII path and leaves out logs/', async () => {
    const { zipArchive } = await import('../../plugins/backup/index.js');
    const { execFileSync } = await import('node:child_process');
    const src = path.join(root, 'ドキュメント', 'data');
    fs.mkdirSync(path.join(src, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(src, 'certs'), { recursive: true });
    fs.writeFileSync(path.join(src, 'memory.json'), '{}');
    fs.writeFileSync(path.join(src, 'certs', 'key.pem'), 'k');
    fs.writeFileSync(path.join(src, 'logs', 'novi.log'), 'l');
    const to = path.join(root, 'ドキュメント', 'out.zip');
    await zipArchive({ from: src, to, exclude: ['logs'] });
    const entries = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -A System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:Z); $z.Entries.FullName; $z.Dispose()'], { env: { ...process.env, Z: to }, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).sort();
    expect(entries).toEqual(['certs/key.pem', 'memory.json']);
  }, 60_000);

  function fakeDrive({ fails = false } = {}) {
    const uploaded = [];
    let st = {};
    return {
      uploaded,
      state: () => st,
      async upload(file) { if (fails) throw new Error('Google is not connected'); uploaded.push(path.basename(file)); st = { lastUpload: { name: path.basename(file), at: '2026-10-08T02:30:00Z' } }; },
      async prune() {},
      fail(err) { st = { ...st, lastError: { message: err.message } }; },
    };
  }

  it('backs up to Google Drive on request (newest local zip) and reports it', async () => {
    const drive = fakeDrive();
    const { host } = setup({ drive });
    const out = await host.get('backup_now').run({ drive: true });
    expect(drive.uploaded).toHaveLength(1);
    expect(out.text).toMatch(/Google Drive/);
    const status = await host.get('backup_status').run({});
    expect(status.text).toMatch(/Last Drive backup: novi-data-/);
  });

  it('says why a Drive backup failed, and status shows it', async () => {
    const drive = fakeDrive({ fails: true });
    const { host } = setup({ drive });
    const out = await host.get('backup_now').run({ drive: true });
    expect(out.text).toMatch(/Drive backup failed: Google is not connected/);
    expect((await host.get('backup_status').run({})).text).toMatch(/Drive backup failed/);
  });
});

