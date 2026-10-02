import { execFile, spawn } from 'node:child_process';

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

export function parseStartApps(json) {
  if (!json || !json.trim()) return [];
  const parsed = JSON.parse(json);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((a) => a?.Name && a?.AppID).map((a) => ({ name: a.Name, appId: a.AppID }));
}

// Installed apps as Windows lists them in the Start menu (desktop and Store apps).
export function loadStartApps() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(parseStartApps(stdout)); } catch (e) { reject(e); }
    });
  });
}

export class AppCatalog {
  constructor({ load = loadStartApps, ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.load = load;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = null;
    this.loadedAt = 0;
  }

  async all() {
    if (!this.cache || this.now() - this.loadedAt > this.ttlMs) {
      this.cache = await this.load();
      this.loadedAt = this.now();
    }
    return this.cache;
  }
}

function score(name, q) {
  const n = norm(name);
  if (n.startsWith(q)) return 3;
  if (` ${n}`.includes(` ${q}`)) return 2;
  if (n.includes(q)) return 1;
  return 0;
}

export function matchApps(apps, query) {
  const q = norm(query);
  if (!q) return [];
  return apps
    .map((app) => ({ app, s: score(app.name, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.app.name.length - b.app.name.length)
    .map((x) => x.app);
}

// { app } when the name clearly means one app, { candidates } when it is ambiguous, null when nothing matches.
export function resolveApp(apps, query) {
  const q = norm(query);
  if (!q) return null;
  const exact = apps.find((a) => norm(a.name) === q);
  if (exact) return { app: exact };
  const ranked = matchApps(apps, q);
  if (!ranked.length) return null;
  if (ranked.length === 1) return { app: ranked[0] };
  const prefix = ranked.filter((a) => norm(a.name).startsWith(q));
  if (prefix.length === 1) return { app: prefix[0] };
  return { candidates: ranked.slice(0, 5) };
}

// Launches by Start-menu AppID, so only installed apps can be started (never arbitrary commands).
export async function launchApp(appId, { spawnImpl = spawn } = {}) {
  const child = spawnImpl('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
}
