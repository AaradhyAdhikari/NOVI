import fs from 'node:fs';
import path from 'node:path';

// The page code Novi serves, by its main script's name (Vite puts a content hash in it). Sent in every
// snapshot so an open page (the phone app keeps one open for days) knows it is old and reloads itself.
export function uiBuildOf(distDir) {
  try {
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    return /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1] || null;
  } catch {
    return null;
  }
}
