import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { definePluginEntry } from '#plugin-sdk';

// Daily backup of data/ (accounts, reminders, memory, voice samples) into backups/.
// The project folder is in OneDrive, so backups also get an off-laptop copy.
// data/secrets.json is DPAPI-encrypted: it restores only on this Windows account.
const KEEP = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const PATTERN = /^novi-data-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/;
const pad = (n) => String(n).padStart(2, '0');

export const backupName = (d) => `novi-data-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;

// Zips with .NET (via PowerShell): Windows' tar.exe fails on non-ASCII paths like "ドキュメント".
// Paths go in environment variables, never into the script text.
const ZIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$src = (Get-Item -LiteralPath $env:NOVI_BACKUP_FROM).FullName.TrimEnd([char]92)', // long name, not AARADH~1
  '$skip = $env:NOVI_BACKUP_EXCLUDE -split ","',
  "$zip = [System.IO.Compression.ZipFile]::Open($env:NOVI_BACKUP_TO, 'Create')",
  'try { Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object { $rel = $_.FullName.Substring($src.Length + 1); if ($skip -notcontains $rel.Split([char[]]@([char]92, [char]47))[0]) { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel.Replace([char]92, "/")) } } } finally { $zip.Dispose() }',
].join('; ');

export function zipArchive({ from, to, exclude = [] }) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ZIP_SCRIPT], {
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, NOVI_BACKUP_FROM: from, NOVI_BACKUP_TO: to, NOVI_BACKUP_EXCLUDE: exclude.join(',') },
  }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve())));
}

export function createBackupPlugin({ archive = zipArchive, now = () => new Date(), intervalMs = 60 * 60 * 1000 } = {}) {
  return definePluginEntry({
    id: 'backup',
    name: 'Backups',
    description: "Zips Novi's data folder once a day (keeps 14).",
    register(api) {
      const dir = path.resolve(api.pluginConfig.dir || 'backups');
      const list = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => PATTERN.test(f)).sort() : []);
      const latest = () => list().at(-1) || null;

      async function backupNow() {
        fs.mkdirSync(dir, { recursive: true });
        const file = backupName(now());
        const to = path.join(dir, file);
        await archive({ from: api.runtime.dataDir, to, exclude: ['logs'] });
        const all = list();
        for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old), { force: true });
        return { file, size: fs.statSync(to).size };
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

      let timer = null;
      api.registerService({
        start: async () => { await backupIfDue(); timer = setInterval(backupIfDue, intervalMs); timer.unref?.(); },
        stop: () => clearInterval(timer),
      });

      api.registerTool({
        name: 'backup_now',
        description: "Back up Novi's data (accounts, reminders, memory, settings) right now.",
        parameters: { type: 'object', properties: {} },
        async execute() {
          const { file, size } = await backupNow();
          return { content: [{ type: 'text', text: `Backed up Novi's data to backups/${file} (${Math.max(1, Math.round(size / 1024))} KB).` }], details: { file, size } };
        },
      });

      api.registerTool({
        name: 'backup_status',
        description: "When Novi's data was last backed up and how many backups are kept.",
        parameters: { type: 'object', properties: {} },
        async execute() {
          const last = latest();
          const text = last ? `Last backup: ${last} (${list().length} kept, newest 14).` : 'No backups yet.';
          return { content: [{ type: 'text', text }], details: { latest: last, count: list().length } };
        },
      });
    },
  });
}

export default createBackupPlugin();
