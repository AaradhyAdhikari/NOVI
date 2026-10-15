// The code that pairs the Novi Chrome extension with this Novi (data/browser.json).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function newCode(file) {
  const code = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ code }));
  return code;
}

export function loadCode(file) {
  try { const { code } = JSON.parse(fs.readFileSync(file, 'utf8')); if (code) return code; } catch { /* first run */ }
  return newCode(file);
}
