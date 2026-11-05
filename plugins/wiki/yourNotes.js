// Notes Novi reads but doesn't own: the copy of Claude Brain inside Novi Brain. This file only reads.
import fs from 'node:fs';
import path from 'node:path';
import { looksSecret } from './vault.js';

const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const MAX_BYTES = 200_000;

export function createYourNotes({ root, skip = null, limit = 300, keepMs = 60_000, now = Date.now }) {
  let kept = null;
  let keptAt = -Infinity;

  function read() {
    if (!root) return [];
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 6 || out.length >= limit) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !(skip && path.resolve(full) === path.resolve(skip))) walk(full, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          try {
            if (fs.statSync(full).size > MAX_BYTES) continue;
            const body = fs.readFileSync(full, 'utf8').replace(/^---[\s\S]*?---\r?\n/, '');
            const text = body.split('\n').filter((line) => !looksSecret(line)).join('\n');
            out.push({ title: e.name.slice(0, -3), text, path: full });
          } catch { /* it went away */ }
        }
      }
    };
    walk(root, 0);
    return out;
  }

  return {
    list() {
      if (!kept || now() - keptAt > keepMs) { kept = read(); keptAt = now(); }
      return kept;
    },
  };
}
