// User notes in Notes/<Title>.md: written only when asked, searched by plain word overlap.
import path from 'node:path';
import { safeTitle } from './vault.js';

const STOP = new Set('a an the is are was were be my me i you your of to in on at for about what whats when where who how why do does did tell check note notes say says said from with and or it this that please novi'.split(' '));
export const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => !STOP.has(w)) || [];
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createNotes({ vault, now = () => new Date() }) {
  const titles = () => vault.list('Notes').map((n) => n.title);
  const find = (title) => titles().find((t) => t.toLowerCase() === String(title).toLowerCase()) || null;
  const body = (title) => (vault.read(path.join('Notes', `${title}.md`)) || '').replace(/^---[\s\S]*?---\n/, '');

  // Other notes' full titles in the text become [[links]] (once each, never inside an existing link).
  const link = (text, self) => titles().filter((t) => t !== self && t.length >= 3).sort((a, b) => b.length - a.length)
    .reduce((out, t) => out.replace(new RegExp(`(?<!\\[\\[)\\b(${escape(t)})\\b(?!\\]\\])`, 'i'), `[[${t}]]`), text);

  return {
    titles,
    find,
    body,
    write({ title, text }) {
      const t = find(title || '') || safeTitle(title || String(text).split(/\s+/).slice(0, 6).join(' '));
      const rel = path.join('Notes', `${t}.md`);
      const today = day(now());
      const linked = link(String(text).trim(), t);
      const existing = vault.read(rel);
      if (existing === null) {
        vault.write(rel, `---\ncreated: ${today}\nupdated: ${today}\nsource: novi\n---\n\n# ${t}\n\n${linked}\n`);
        return { title: t, created: true };
      }
      vault.write(rel, `${existing.replace(/^updated: .*$/m, `updated: ${today}`).trimEnd()}\n\n${linked}\n`);
      return { title: t, created: false };
    },
    search(question, k = 6) {
      const q = words(question);
      return titles().map((t) => {
        const tw = new Set(words(t));
        const bw = words(body(t));
        const score = q.reduce((s, w) => s + (tw.has(w) ? 3 : 0) + (bw.includes(w) ? 1 : 0), 0);
        return { title: t, text: body(t), score };
      }).filter((n) => n.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
    },
  };
}
