// Where flicked things go: Downloads\Novi Flick\<date>\<safe name>, never overwriting.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const KINDS = {
  photo: /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i,
  video: /\.(mp4|mov|mkv|webm|avi|3gp|m4v)$/i,
  doc: /\.(pdf|docx|xlsx|pptx|txt|md|csv)$/i, // plain documents only, no macro files (security review)
  program: /\.(exe|msi|bat|cmd|com|ps1|vbs|js|jse|wsf|scr|lnk|reg|hta|jar|apk|appx|msix)$/i,
};

export const defaultRoot = () => path.join(os.homedir(), 'Downloads', 'Novi Flick');

export function safeName(name) {
  // Direction-flipping characters hide a real extension ("photo‮gpj.exe"), so they go first.
  let n = String(name || '').replace(/[‪-‮⁦-⁩‎‏]/g, '').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/^\.+/, '').trim();
  n = n.replace(/[. ]+$/, '');
  if (!n) return 'file';
  const base = n.replace(/\.[^.]*$/, '');
  if (RESERVED.test(base)) n = n.replace(base, `${base}_`);
  return n.slice(0, 150);
}

export function kindOf(name, type = '') {
  // Only the name's own ending counts (security review): the phone's type header never makes a file a photo or
  // video, since Windows opens a file by its ending, not by what the phone called it. `type` is kept for callers.
  void type;
  for (const [k, re] of Object.entries(KINDS)) if (re.test(name)) return k;
  return 'file';
}

const ENDINGS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
// A name with no ending gets one from a picture or video type, so it is saved (and opens) as what it is.
export function withEnding(name, type = '') {
  const n = String(name || 'file');
  return /\.[a-z0-9]{1,5}$/i.test(n) ? n : n + (ENDINGS[String(type).toLowerCase()] || '');
}

// A link opens by itself on the laptop only when it can't be a one-time sign-in or reset link (opening one there
// could use it up, security review); those wait for a tap on the stage.
export function autoOpens(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.search.length > 100) return false;
  return !/(token|reset|magic|auth|login|signin|sign-in|verify|otp|code=|session|password|invite)/i.test(u.pathname + u.search);
}

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Moves (or copies, across drives) the temp file into place; returns the final path.
export function saveFlick({ tmp, name, root = defaultRoot(), now = new Date() }) {
  const dir = path.join(root, day(now));
  fs.mkdirSync(dir, { recursive: true });
  const clean = safeName(name);
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  let target = path.join(dir, clean);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
  try { fs.renameSync(tmp, target); } catch { fs.copyFileSync(tmp, target); fs.rmSync(tmp, { force: true }); }
  return target;
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|kick\.com|instagram\.com|tiktok\.com)$/i;

// A link from the phone: http(s) only (the first one in the text). Videos keep their own time (?t=…).
export function linkItem(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  let u;
  try { u = new URL(m[0]); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '');
  const isVideo = VIDEO_HOSTS.test(host) && (host !== 'youtube.com' || /\/(watch|shorts|live)/.test(u.pathname));
  return { kind: isVideo ? 'video' : 'link', url: u.toString(), host, name: host };
}
