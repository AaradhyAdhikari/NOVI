// Every command Novi was asked to run (also refused and declined ones), one JSON line each in
// data/commands/history.jsonl. Keeps the last 500. Shown in Settings → History and by voice.
import fs from 'node:fs';
import path from 'node:path';

const OUTPUT = 300;
const lowerFirst = (s) => String(s || '').replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());

export function createHistory({ file, now = () => new Date(), keep = 500, rewriteAt = 600, logger = console } = {}) {
  let entries = [];
  try { entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  const sameDay = (iso, d) => new Date(iso).toDateString() === d.toDateString();

  function save(entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (entries.length > rewriteAt) {
        entries = entries.slice(-keep);
        fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      } else {
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      }
    } catch (err) {
      logger.warn?.(`[commands] could not save the history: ${err.message}`);
    }
  }

  return {
    add(e) {
      const entry = { at: now().toISOString(), from: e.from || 'laptop', level: e.level, purpose: e.purpose || '', command: e.command || '', ran: Boolean(e.ran), ok: Boolean(e.ok), exitCode: e.exitCode ?? null, output: String(e.output || '').slice(0, OUTPUT) };
      entries.push(entry);
      save(entry);
      return entry;
    },
    list({ today = false, limit = 100 } = {}) {
      const d = now();
      return entries.filter((e) => !today || sameDay(e.at, d)).slice(-limit).reverse();
    },
    summary() {
      const ran = this.list({ today: true, limit: 1000 }).filter((e) => e.ran);
      if (!ran.length) return 'None today.';
      return `${ran.length} today. Last: ${ran.slice(0, 3).map((e) => lowerFirst(e.purpose)).join(', ')}.`;
    },
  };
}
