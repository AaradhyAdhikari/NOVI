// "Show me the code for the contact page" → the code in the chat with Edit / Approve (2026-10-17).
// offer() remembers what one card showed (which lines of which file, and the whole file as it was);
// save() puts the user's version in place of exactly those lines — only if the file hasn't changed
// since (Claude may have kept working), only inside the project, and only within 30 minutes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from './errors.js';

const AGAIN = 'That code card is too old. Ask for the code again, then edit it.';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function createCodeEdits({ now = Date.now, ttlMs = 30 * 60_000 } = {}) {
  const cards = new Map(); // id → { root, file, abs, start, count, hash, expires }

  const inside = (root, file) => {
    const abs = path.resolve(root, file);
    const rel = path.relative(path.resolve(root), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new UserFacingError("That file isn't inside the project.");
    return abs;
  };

  return {
    offer({ root, file, start, lines }) {
      const abs = inside(root, file);
      const text = fs.readFileSync(abs, 'utf8');
      for (const [id, c] of cards) if (c.expires <= now()) cards.delete(id);
      const id = crypto.randomUUID();
      cards.set(id, { root, file, abs, start, count: lines.length, hash: hash(text), expires: now() + ttlMs });
      return id;
    },

    // → { file, start, end, changed }
    save(id, edited) {
      const card = cards.get(id);
      if (!card || card.expires <= now()) throw new UserFacingError(AGAIN);
      const text = fs.readFileSync(card.abs, 'utf8');
      if (hash(text) !== card.hash) throw new UserFacingError(`${card.file} has changed since I showed it (the coder may still be working on it). Ask for the code again, then edit it.`);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(/\r?\n/);
      const replacement = String(edited).replace(/\r\n/g, '\n').split('\n');
      const before = lines.slice(card.start - 1, card.start - 1 + card.count);
      const changed = before.join('\n') !== replacement.join('\n');
      if (changed) {
        lines.splice(card.start - 1, card.count, ...replacement);
        const out = lines.join(eol);
        fs.writeFileSync(card.abs, out);
        // The same card can be saved again (a second fix) against what is now on disk.
        card.hash = hash(out);
        card.count = replacement.length;
      }
      return { file: card.file, start: card.start, end: card.start + replacement.length - 1, changed };
    },
  };
}
