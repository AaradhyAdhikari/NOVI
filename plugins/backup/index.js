import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';
import { createDriveUploader } from './drive.js';
import { everyDayAt } from '../../server/daily.js';

// Daily backup of data/ (accounts, reminders, memory, voice samples) into backups/.
// The search index (data/brain) stays out: it rebuilds itself, and its 919 MB broke the zips (2026-11-05).
// The user's Obsidian vault gets its own zip. Off-laptop copies go to Google Drive (see drive.js).
// data/secrets.json is DPAPI-encrypted: it restores only on this Windows account.
const KEEP = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const PATTERN = /^novi-data-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/;
const zipsOf = (kind) => new RegExp(`^novi-${kind}-\\d{4}-\\d{2}-\\d{2}-\\d{4}\\.zip$`);
const pad = (n) => String(n).padStart(2, '0');

export const backupName = (d, kind = 'data') => `novi-${kind}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;

// Zips with .NET (via PowerShell): Windows' tar.exe fails on non-ASCII paths like "ドキュメント".
// Paths go in environment variables, never into the script text.
const ZIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$src = (Get-Item -LiteralPath $env:NOVI_BACKUP_FROM).FullName.TrimEnd([char]92)', // long name, not AARADH~1
  '$skip = $env:NOVI_BACKUP_EXCLUDE -split ","',
  "$zip = [System.IO.Compression.ZipFile]::Open($env:NOVI_BACKUP_TO, 'Create')",
  'try { Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object { $rel = $_.FullName.Substring($src.Length + 1); if ($skip -notcontains $rel.Split([char[]]@([char]92, [char]47))[0]) { try { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel.Replace([char]92, "/")) } catch { [Console]::Error.WriteLine("skipped " + $rel) } } } } finally { $zip.Dispose() }',
].join('; ');

export function zipArchive({ from, to, exclude = [] }) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ZIP_SCRIPT], {
    windowsHide: true,
    timeout: 5 * 60_000,
    env: { ...process.env, NOVI_BACKUP_FROM: from, NOVI_BACKUP_TO: to, NOVI_BACKUP_EXCLUDE: exclude.join(',') },
  }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve())));
}

// driveUploader(api) → the Drive copier (plugins/backup/drive.js); injectable for tests.
export function createBackupPlugin({ archive = zipArchive, now = () => new Date(), intervalMs = 60 * 60 * 1000, driveUploader = (api) => createDriveUploader({ google: api.runtime.google, stateFile: path.join(api.runtime.dataDir || path.resolve('data'), 'backup', 'drive.json') }) } = {}) {
  return definePluginEntry({
    id: 'backup',
    name: 'Backups',
    description: "Zips Novi's data folder once a day (keeps 14).",
    register(api) {
      const dir = path.resolve(api.pluginConfig.dir || 'backups');
      const named = (pattern) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => pattern.test(f)).sort() : []);
      const list = () => named(PATTERN);
      const latest = () => list().at(-1) || null;
      // Two separate Obsidian vaults: Novi's own, and Brain (Claude's), which Novi only backs up, never reads.
      const vaults = () => [{ kind: 'vault', from: api.runtime.vaultDir }, { kind: 'brain', from: api.pluginConfig.brain_vault }].filter((v) => v.from && fs.existsSync(v.from));
      const tidy = (pattern) => {
        const all = named(pattern);
        for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old), { force: true });
      };
      // A zip that failed is deleted: left behind, it counted as today's backup.
      const zipTo = async (options) => {
        try { await archive(options); } catch (err) { fs.rmSync(options.to, { force: true }); throw err; }
      };

      async function backupNow() {
        fs.mkdirSync(dir, { recursive: true });
        const file = backupName(now());
        const to = path.join(dir, file);
        await zipTo({ from: api.runtime.dataDir, to, exclude: ['logs', 'brain'] });
        tidy(PATTERN);
        const out = { file, size: fs.statSync(to).size };
        for (const { kind, from } of vaults()) {
          const vaultFile = backupName(now(), kind);
          try {
            await zipTo({ from, to: path.join(dir, vaultFile), exclude: ['.trash'] });
            tidy(zipsOf(kind));
            out.vaultFile = vaultFile;
          } catch (err) {
            out.vaultError = err.message;
            api.logger?.warn?.(`[backup] ${kind} vault failed: ${err.message}`);
          }
        }
        return out;
      }

      async function backupIfDue() {
        const last = latest();
        if (last && now() - fs.statSync(path.join(dir, last)).mtime < DAY_MS) return;
        try {
          const { file } = await backupNow();
          api.logger?.log?.(`[backup] saved ${file}`);
        } catch (err) {
          api.logger?.warn?.(`[backup] failed: ${err.message}`);
        }
      }

      // Nightly copy of the newest zip to Google Drive (keeps 7 there).
      const drive = driveUploader(api);
      async function toDrive() {
        if (!latest()) await backupNow();
        try {
          await drive.upload(path.join(dir, latest()));
          await drive.prune(7, 'novi-data-');
          for (const { kind } of vaults()) {
            const newest = named(zipsOf(kind)).at(-1);
            if (!newest) continue;
            await drive.upload(path.join(dir, newest));
            await drive.prune(7, `novi-${kind}-`);
          }
          return { ok: true };
        } catch (err) {
          drive.fail(err);
          return { ok: false, error: err.message };
        }
      }
      const nightly = everyDayAt({
        time: api.pluginConfig.drive_time || '02:30', // NOVI_PLUGIN_BACKUP_DRIVE_TIME
        stateFile: path.join(api.runtime.dataDir || path.resolve('data'), 'backup', 'drive-daily.json'),
        now,
        logger: api.logger || console,
        run: async () => {
          const r = await toDrive();
          if (!r.ok) api.logger?.warn?.(`[backup] Drive backup failed: ${r.error}`);
        },
      });

      let timer = null;
      api.registerService({
        start: async () => { await backupIfDue(); timer = setInterval(backupIfDue, intervalMs); timer.unref?.(); nightly.start(); },
        stop: () => { clearInterval(timer); nightly.stop(); },
      });

      api.registerTool({
        name: 'backup_now',
        description: "Back up Novi's data (accounts, reminders, memory, settings) right now. drive: true also copies it to the user's Google Drive.",
        parameters: { type: 'object', properties: { drive: { type: 'boolean', description: 'Also copy it to Google Drive' } } },
        async execute(_id, { drive: alsoDrive = false } = {}) {
          const { file, size, vaultFile, vaultError } = await backupNow();
          let text = `Backed up Novi's data to backups/${file} (${Math.max(1, Math.round(size / 1024))} KB).`;
          if (vaultFile) text += ' Your Obsidian vaults too.';
          if (vaultError) text += ` The Obsidian vault backup failed: ${vaultError}`;
          if (alsoDrive) {
            const r = await toDrive();
            text += r.ok ? ' Also copied to Google Drive (Novi backups).' : ` Drive backup failed: ${r.error}`;
          }
          return { content: [{ type: 'text', text }], details: { file, size } };
        },
      });

      api.registerTool({
        name: 'backup_status',
        description: "When Novi's data was last backed up and how many backups are kept.",
        parameters: { type: 'object', properties: {} },
        async execute() {
          const last = latest();
          const d = drive.state();
          const driveLine = d.lastError ? ` Drive backup failed: ${d.lastError.message}` : d.lastUpload ? ` Last Drive backup: ${d.lastUpload.name}.` : '';
          const text = (last ? `Last backup: ${last} (${list().length} kept, newest 14).` : 'No backups yet.') + driveLine;
          return { content: [{ type: 'text', text }], details: { latest: last, count: list().length, drive: d } };
        },
      });
    },
  });
}

export default createBackupPlugin();
