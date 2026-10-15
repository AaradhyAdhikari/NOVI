// Which window a spoken app name means. Aliases first ("chrome" = chrome.exe, "vs code" = Code.exe),
// then the name inside a title ("gmail"), then one-letter speech slips ("whatsap"). Novi's own page
// is never a match and never "the window you're working in".
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi']);
const APPS = [
  { names: ['chrome', 'google chrome'], process: 'chrome', label: 'Chrome' },
  { names: ['edge', 'microsoft edge'], process: 'msedge', label: 'Edge' },
  { names: ['firefox'], process: 'firefox', label: 'Firefox' },
  { names: ['brave'], process: 'brave', label: 'Brave' },
  { names: ['vs code', 'vscode', 'code', 'visual studio code'], process: 'code', label: 'VS Code' },
  { names: ['cursor'], process: 'cursor', label: 'Cursor' },
  { names: ['antigravity'], process: 'antigravity', label: 'Antigravity' },
  { names: ['whatsapp', 'whats app'], process: 'whatsapp', label: 'WhatsApp' },
  { names: ['telegram'], process: 'telegram', label: 'Telegram' },
  { names: ['discord'], process: 'discord', label: 'Discord' },
  { names: ['spotify'], process: 'spotify', label: 'Spotify' },
  { names: ['file explorer', 'explorer', 'files', 'my files'], process: 'explorer', label: 'File Explorer' },
  { names: ['word', 'ms word', 'microsoft word'], process: 'winword', label: 'Word' },
  { names: ['excel', 'microsoft excel'], process: 'excel', label: 'Excel' },
  { names: ['powerpoint', 'power point', 'ppt'], process: 'powerpnt', label: 'PowerPoint' },
  { names: ['notepad'], process: 'notepad', label: 'Notepad' },
  { names: ['terminal', 'windows terminal'], process: 'windowsterminal', label: 'Terminal' },
  { names: ['claude'], process: 'claude', label: 'Claude' },
];

const lower = (s) => String(s || '').toLowerCase();
// WhatsApp from the Store runs as "WhatsApp.Root": compare the part before the first dot.
const proc = (w) => lower(w.process).split('.')[0];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isNovi = (w) => BROWSERS.has(proc(w)) && /^novi\b/i.test(String(w.title || '').trim());

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = keep;
    }
  }
  return prev[b.length];
}

export function findWindows(list, name) {
  const n = lower(name).trim().replace(/^the\s+/, '').replace(/\s+(?:app|application|windows?)$/, '').trim();
  if (!n || n === 'novi') return [];
  const windows = (list || []).filter((w) => !isNovi(w));
  const byApp = (app) => windows.filter((w) => proc(w) === app.process);
  const alias = APPS.find((a) => a.names.includes(n));
  if (alias) return byApp(alias);
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, 'iu');
  const named = windows.filter((w) => proc(w) === n || word.test(w.title));
  if (named.length || n.length < 5) return named;
  const near = APPS.find((a) => a.names.some((x) => distance(x, n) <= 1));
  if (near) return byApp(near);
  return windows.filter((w) => distance(proc(w), n) <= 1);
}

export const workWindow = (list) => (list || []).find((w) => !isNovi(w)) || null;

export function appLabel(w) {
  const app = APPS.find((a) => a.process === proc(w));
  return app ? app.label : String(w.process || w.title || 'that app');
}
