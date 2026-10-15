// A picture of a web page from a hidden Edge (its own empty profile, so not signed in anywhere).
// Used by the screen plugin (screen_page) and the preview plugin (phone-sized, 390×844).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const EDGE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');

export async function pageShot(url, { width = 1280, height = 1400 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-page-'));
  const file = path.join(dir, 'page.png');
  try {
    await new Promise((resolve, reject) => execFile(EDGE, [
      // --do-not-de-elevate: when Novi runs with admin rights Edge would otherwise hand off to a
      // normal-rights copy and the screenshot is lost.
      '--headless=new', '--do-not-de-elevate', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(dir, 'profile')}`,
      `--window-size=${width},${height}`, '--virtual-time-budget=10000', `--screenshot=${file}`, url,
    ], { windowsHide: true, timeout: 45_000 }, (err) => (err && !fs.existsSync(file) ? reject(err) : resolve())));
    // msedge.exe can return while a child process is still loading the page: wait for the file
    // (and for it to stop growing).
    let last = -1;
    for (let waited = 0; waited < 25_000; waited += 300) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
      if (size > 0 && size === last) return { png: fs.readFileSync(file) };
      last = size;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("The page didn't load in time, so there's no picture.");
  } finally {
    // Edge's helper processes hold the profile for a moment after it exits; clean up later if needed.
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}
