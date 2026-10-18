// The Novi Memory folder: plain Markdown files the user can open in Obsidian (Documents\Novi Memory).
import fs from 'node:fs';
import path from 'node:path';

export function memoryDir({ env = process.env, home, exists = fs.existsSync } = {}) {
  if (env.NOVI_MEMORY_DIR) return env.NOVI_MEMORY_DIR;
  const docs = [path.join(home, 'OneDrive', 'ドキュメント'), path.join(home, 'OneDrive', 'Documents')].find((d) => exists(d)) || path.join(home, 'Documents');
  return path.join(docs, 'Novi Memory');
}

// Never written to notes: passwords, one-time codes, PINs, card numbers, API keys.
const SECRET = [
  /\b(?:password|passwd|pass ?code|pin|otp|cvv|one[- ]time (?:code|password)|verification code)\b/i,
  /\b(?:\d[ -]?){13,19}\b/, // card-like number
  /\b(?:sk|gsk|pk|ghp|gho|xox[abp]|AIza)[-_]?[A-Za-z0-9_-]{16,}\b/, // API-key-like
];
export const looksSecret = (text) => SECRET.some((re) => re.test(String(text || '')));

export const safeTitle = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f#^[\]]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80);

const HOME_PAGE = `# Novi Memory

Novi's notes. Open this folder in Obsidian ("Open folder as vault") to browse and edit them.

- [[Actions]]: what Novi did, one file per day (\`Actions/\`)
- Notes: things you asked Novi to write down (\`Notes/\`)
`;

export function createVault(dir) {
  const abs = (rel) => path.join(dir, rel);
  return {
    dir,
    ensure() {
      fs.mkdirSync(path.join(dir, 'Actions'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'Notes'), { recursive: true });
      if (!fs.existsSync(abs('Novi Memory.md'))) fs.writeFileSync(abs('Novi Memory.md'), HOME_PAGE);
    },
    write(rel, text) { this.ensure(); fs.writeFileSync(abs(rel), text); },
    append(rel, text) { this.ensure(); fs.appendFileSync(abs(rel), text); },
    read(rel) { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; } },
    exists(rel) { return fs.existsSync(abs(rel)); },
    // Also a change of capitals only (Windows keeps the old ones if you write the new name instead).
    rename(from, to) { fs.renameSync(abs(from), abs(to)); },
    list(sub) {
      try {
        return fs.readdirSync(abs(sub)).filter((f) => f.endsWith('.md')).map((f) => ({ rel: path.join(sub, f), title: f.slice(0, -3), mtime: fs.statSync(abs(path.join(sub, f))).mtimeMs }));
      } catch { return []; }
    },
  };
}
