import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STOP = new Set('a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its me my of on or our she so that the their them they this to was we were what when where which who why will with would you your yours about please tell remember know'.split(' '));

export const tokens = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t));

// How well a fact matches a question: exact words count fully, shared word starts ("birthday"/"birthdays") a bit less.
export function score(fact, query) {
  const f = tokens(fact);
  let s = 0;
  for (const q of new Set(tokens(query))) {
    if (f.includes(q)) s += 1;
    else if (q.length >= 4 && f.some((w) => w.length >= 4 && (w.startsWith(q) || q.startsWith(w)))) s += 0.7;
  }
  return s;
}

// "My favourite editor is Cursor" and "My favourite editor is VS Code" are about the same thing.
const subject = (text) => {
  const m = /^(.{3,80}?)\s+(?:is|are|was|=|:)\s+/i.exec(String(text).trim());
  return m ? tokens(m[1]).join(' ') : null;
};
const similar = (a, b) => {
  const sa = subject(a);
  if (sa && sa === subject(b)) return true;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const both = [...ta].filter((t) => tb.has(t)).length;
  return both / (new Set([...ta, ...tb]).size || 1) >= 0.75;
};

const pad = (n) => String(n).padStart(2, '0');
export const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d) => `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export class LongTermMemory {
  constructor(dir, now = () => new Date()) {
    this.dir = dir;
    this.now = now;
    this.factsFile = path.join(dir, 'facts.json');
    this.convDir = path.join(dir, 'conversations');
  }

  facts() {
    try { return JSON.parse(fs.readFileSync(this.factsFile, 'utf8')); } catch { return []; }
  }

  _save(facts) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.factsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(facts, null, 2));
    fs.renameSync(tmp, this.factsFile);
  }

  remember(text) {
    const clean = String(text).trim().slice(0, 500);
    const facts = this.facts();
    const at = this.now().toISOString();
    const old = facts.find((f) => similar(f.text, clean));
    if (old) Object.assign(old, { text: clean, updatedAt: at });
    else facts.push({ id: crypto.randomUUID().slice(0, 8), text: clean, createdAt: at, updatedAt: at });
    this._save(facts);
    return { fact: old || facts.at(-1), updated: Boolean(old) };
  }

  search(query, limit = 5) {
    return this.facts()
      .map((f) => ({ f, s: score(f.text, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.f.updatedAt.localeCompare(a.f.updatedAt))
      .slice(0, limit)
      .map((x) => x.f);
  }

  forget(id) {
    const facts = this.facts();
    const i = facts.findIndex((f) => f.id === id);
    if (i === -1) return null;
    const [gone] = facts.splice(i, 1);
    this._save(facts);
    return gone;
  }

  logExchange(user, novi) {
    fs.mkdirSync(this.convDir, { recursive: true });
    const d = this.now();
    fs.appendFileSync(path.join(this.convDir, `${localDay(d)}.jsonl`), `${JSON.stringify({ at: localStamp(d), user, novi })}\n`);
  }

  day(date) {
    try {
      return fs.readFileSync(path.join(this.convDir, `${date}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  searchConversations(query, limit = 10) {
    if (!fs.existsSync(this.convDir)) return [];
    const out = [];
    for (const file of fs.readdirSync(this.convDir).filter((f) => f.endsWith('.jsonl')).sort().reverse()) {
      for (const e of this.day(file.replace('.jsonl', '')).reverse()) {
        if (score(`${e.user} ${e.novi}`, query) > 0) out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
