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
  for (const [k, re] of Object.entries(KINDS)) if (re.test(name)) return k;
  if (/^image\//.test(type)) return 'photo';
  if (/^video\//.test(type)) return 'video';
  return 'file';
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
