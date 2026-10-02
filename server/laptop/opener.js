import { spawn } from 'node:child_process';
import { UserFacingError } from '../errors.js';

const DOWNLOAD_EXT = /\.(exe|msi|bat|cmd|ps1|vbs|scr|com|zip|rar|7z|dmg|pkg|apk|jar|iso)$/i;
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/;

// Turns what the user (or the brain) asked for into a safe http(s) URL:
// full links are kept, bare domains get https, anything else becomes a Google search.
export function toUrl(target) {
  const text = String(target || '').trim();
  if (!text) throw new UserFacingError('Tell me which website to open.');
  let url;
  if (/^https?:\/\//i.test(text)) url = new URL(text);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !BARE_DOMAIN.test(text)) throw new UserFacingError('I can only open web links (http or https).');
  else if (BARE_DOMAIN.test(text)) url = new URL(`https://${text}`);
  else return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserFacingError('I can only open web links (http or https).');
  if (DOWNLOAD_EXT.test(url.pathname)) throw new UserFacingError("That link is a direct download, so I won't open it automatically.");
  return url.href;
}

// Opens a URL in the laptop's default browser.
export async function openUrl(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const [command, args] = platform === 'win32' ? ['explorer.exe', [url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
}
