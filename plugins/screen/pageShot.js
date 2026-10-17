// A picture of a web page from a hidden Edge (its own empty profile, so not signed in anywhere).
// Used by the screen plugin (screen_page) and the preview plugin (phone-sized, 390×844).
// A blank (one-colour) picture is taken once more with more time and reduced motion; still blank →
// an error saying so (live 2026-10-17: a working portfolio came out all black).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';

const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');

async function edgeShot(url, { width = 1280, height = 1400, retry = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-page-'));
  const file = path.join(dir, 'page.png');
  try {
    await new Promise((resolve, reject) => execFile(EDGE, [
      // --do-not-de-elevate: when Novi runs with admin rights Edge would otherwise hand off to a
      // normal-rights copy and the screenshot is lost.
      '--headless=new', '--do-not-de-elevate', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`,
      // The second try: GPU drawing on (some pages paint nothing without it), sites' reduced-motion
      // styles (no fade-ins left at opacity 0), and more time.
      ...(retry ? ['--force-prefers-reduced-motion', '--virtual-time-budget=20000'] : ['--disable-gpu', '--virtual-time-budget=10000']),
      `--window-size=${width},${height}`, `--screenshot=${file}`, url,
    ], { windowsHide: true, timeout: 45_000 }, (err) => (err && !fs.existsSync(file) ? reject(err) : resolve())));
    // msedge.exe can return while a child process is still loading the page: wait for the file
    // (and for it to stop growing).
    let last = -1;
    for (let waited = 0; waited < 25_000; waited += 300) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
      if (size > 0 && size === last) return fs.readFileSync(file);
      last = size;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("The page didn't load in time, so there's no picture.");
  } finally {
    // Edge's helper processes hold the profile for a moment after it exits; clean up later if needed.
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}

export async function pageShot(url, { width = 1280, height = 1400, shoot = edgeShot, retryDelayMs = 3000 } = {}) {
  const first = await shoot(url, { width, height });
  if (!isBlankPicture(first)) return { png: first };
  await new Promise((r) => setTimeout(r, retryDelayMs)); // a dev server may still be building the page
  const second = await shoot(url, { width, height, retry: true });
  if (!isBlankPicture(second)) return { png: second };
  throw Object.assign(new Error('The picture came out blank (the page may still be loading)'), { blank: true });
}

// True when (almost) every pixel is the same colour. Reads 8-bit RGB / RGBA PNGs as Edge writes them;
// anything else counts as "not blank" (better a doubtful picture than none).
export function isBlankPicture(png) {
  try {
    if (!Buffer.isBuffer(png) || png.readUInt32BE(0) !== 0x89504e47) return false;
    let pos = 8; let width = 0; let height = 0; let type = 0; const idat = [];
    while (pos < png.length) {
      const len = png.readUInt32BE(pos); const kind = png.toString('ascii', pos + 4, pos + 8);
      const data = png.subarray(pos + 8, pos + 8 + len);
      if (kind === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9];
        if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) return false;
      } else if (kind === 'IDAT') idat.push(data);
      else if (kind === 'IEND') break;
      pos += 12 + len;
    }
    const bpp = type === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    let prev = Buffer.alloc(stride);
    const first = []; let same = 0; let total = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0; const b = prev[x]; const c = x >= bpp ? prev[x - bpp] : 0;
        const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1
          : filter === 4 ? (() => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })() : 0;
        line[x] = (line[x] + add) & 0xff;
      }
      for (let x = 0; x < stride; x += bpp) {
        if (!first.length) first.push(line[x], line[x + 1], line[x + 2]);
        total += 1;
        if (Math.abs(line[x] - first[0]) <= 8 && Math.abs(line[x + 1] - first[1]) <= 8 && Math.abs(line[x + 2] - first[2]) <= 8) same += 1;
      }
      prev = line;
    }
    return total > 0 && same / total >= 0.995;
  } catch {
    return false;
  }
}
