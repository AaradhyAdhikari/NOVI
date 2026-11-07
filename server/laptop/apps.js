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

// What people call apps, for names that share no words with the real one.
const ALIASES = {
  vscode: 'Visual Studio Code', 'vs code': 'Visual Studio Code', code: null, calc: 'Calculator', explorer: 'File Explorer', files: 'File Explorer',
  ppt: 'PowerPoint', powerpoint: 'PowerPoint', cmd: 'Command Prompt', 'command line': 'Command Prompt', 'paint app': 'Paint', browser: 'Google Chrome',
};
const squash = (s) => norm(s).replace(/ /g, '');

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// The nearest app by spelling, for what speech-to-text gets slightly wrong. Whole names and their long words.
function nearest(apps, q) {
  const word = squash(q);
  if (word.length < 5) return null;
  const scored = apps.map((app) => {
    const parts = [squash(app.name), ...norm(app.name).split(' ').filter((w) => w.length >= 5)];
    // Three letters off is a slip only between words of about the same length: "photoshop" is not "Photos".
    const off = (p) => { const d = distance(word, p); return d >= 3 && Math.abs(word.length - p.length) > 1 ? Infinity : d; };
    return { app, d: Math.min(...parts.map(off)) };
  }).sort((a, b) => a.d - b.d);
  const [best, next] = scored;
  if (!best || best.d > (word.length >= 7 ? 3 : 2)) return null;
  if (best.d === 1 && next?.d !== 1) return { app: best.app };
  return { suggest: best.app };
}

// { app } when the name clearly means one app, { candidates } when it is ambiguous, { suggest } when it only
// looks like one (asked, never opened by itself), null when nothing is near it.
export function resolveApp(apps, query) {
  const q = norm(query).replace(/ (?:app|application)$/, '');
  if (!q) return null;
  const exact = apps.find((a) => norm(a.name) === q) || apps.find((a) => squash(a.name) === squash(q));
  if (exact) return { app: exact };
  const alias = ALIASES[q] && apps.find((a) => a.name === ALIASES[q]);
  if (alias) return { app: alias };
  if (q.length < 3) return null;
  const ranked = matchApps(apps, q);
  if (!ranked.length) return nearest(apps, q);
  if (ranked.length === 1) return { app: ranked[0] };
  const prefix = ranked.filter((a) => norm(a.name).startsWith(q));
  if (prefix.length === 1) return { app: prefix[0] };
  return { candidates: ranked.slice(0, 5) };
}

// Launches by Start-menu AppID, so only installed apps can be started (never arbitrary commands).
export async function launchApp(appId, { spawnImpl = spawn } = {}) {
  // Steam games and the like are listed as a link, not a Start-menu id.
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(appId) ? appId : `shell:AppsFolder\\${appId}`;
  const child = spawnImpl('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on?.('error', () => {});
  child.unref?.();
}
