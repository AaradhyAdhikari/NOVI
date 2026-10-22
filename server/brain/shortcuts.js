// Learned shortcuts (the user's idea, 2026-10-17): when the AI works out a request with ONE quiet tool
// that succeeds ("show my gidhub contribution yesterday" → github_graph), Novi remembers
// "these words → that tool" and next time runs it at once — no AI call, no "providers are busy".
// Only safe things are learned: no approval was needed, nothing is sent/deleted/written, the tool
// itself says what happened (or already showed it), and the words don't point back ("it", "that").
// "today" / "yesterday" / "tomorrow" in the arguments are worked out again each time.
// data/shortcuts.json; Settings → Shortcuts lists them and can remove one.
import fs from 'node:fs';
import path from 'node:path';

const LEAD = /^(?:(?:ok(?:ay)?|hey novi|hey|novi|please|can you|could you|would you|will you|pls)\s+)+/;
const TAIL = /(?:\s+(?:please|for me|right now|now|thanks|thank you|pls))+$/;
export function phraseKey(text) {
  return String(text || '').toLowerCase().replace(/[.!?,;:"“”'’]+/g, ' ').replace(/\s+/g, ' ').trim().replace(LEAD, '').replace(TAIL, '').trim();
}

// Tools that change, send, delete or depend on what came just before — never replayed.
// A question never becomes a shortcut to an action (live 2026-10-22: "what is my tip calculator project
// about" was learned as "open it in VS Code" because the AI did that once).
const QUESTION = /^(?:what|whats|where|wheres|when|why|how|who|which|is|are|does|do|did|tell me|kya|kaha|kahan|kab|kaise|kaun)\b/;
const ACTION_TOOL = /^(?:open_|play_|file_open|preview_open|launch)/;
const NEVER =/^(?:code_|whatsapp_|browser_|screen_(?!show$)|laptop_(?:run|power|window|clipboard|radio)|file_(?:delete|gather|undo_move|rename|new_folder|summary)|note_write|memory_remember|reminder_|timer_|calendar_add|tasks_(?:add|complete)|rename_project|forget_|remember_|preview_stop)|_(?:send|delete|add|write|mark_read|set)$/;
const POINTS_BACK = /\b(?:it|this|that|these|those|her|him|them|usko|isko|again|same|previous|last one)\b/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// What to say after a replay: the tool's own words. '' = it already showed the answer (a picture).
export function replyFrom(output = {}) {
  if (typeof output.note === 'string' && output.note) return output.note;
  // The briefing's text is written for the AI ("Say this: … Details: …"): keep the words, drop the labels.
  if (typeof output.text === 'string' && output.text && output.spoken) return output.text.replace(/^Say this:\s*/, '').replace(/\n\nDetails:\n/, '\n\n');
  if (typeof output.text === 'string' && output.text) return output.text;
  if (output.opened) return `Opened ${output.opened}.`;
  return '';
}

const day = (d, shift = 0) => { const x = new Date(d); x.setDate(x.getDate() + shift); return x.toLocaleDateString('en-CA'); };
const RELATIVE = { $yesterday: -1, $today: 0, $tomorrow: 1 };

// seeds: starter shortcuts ([{ words, tool, args }], server/brain/shortcutSeeds.js). Each phrase is added
// once (remembered in shortcuts-seeded.json), so one the user removes never comes back.
export function createShortcuts({ file, now = () => new Date(), max = 300, seeds = [] } = {}) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* none yet */ }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  };

  const seededFile = path.join(path.dirname(file), 'shortcuts-seeded.json');
  let seeded = [];
  try { seeded = JSON.parse(fs.readFileSync(seededFile, 'utf8')) || []; } catch { /* none yet */ }
  const fresh = seeds.flatMap((s) => s.words.map((w) => ({ key: phraseKey(w), said: w, tool: s.tool, args: s.args || {} }))).filter((s) => !seeded.includes(s.key));
  if (fresh.length) {
    for (const s of fresh) {
      if (!saved[s.key]) saved[s.key] = { tool: s.tool, args: s.args, said: s.said, uses: 0, at: now().toISOString(), seed: true };
      seeded.push(s.key);
    }
    save();
    fs.writeFileSync(seededFile, JSON.stringify(seeded, null, 2));
  }

  // Dates become $today / $yesterday / $tomorrow; any other date or a clock time → not learnable.
  const template = (args) => {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (typeof v === 'string' && DATE.test(v)) {
        const rel = Object.entries(RELATIVE).find(([, shift]) => day(now(), shift) === v);
        if (!rel) return null;
        out[k] = rel[0];
      } else if (typeof v === 'string' && /\b\d{1,2}:\d{2}\b/.test(v)) return null;
      else out[k] = v;
    }
    return out;
  };
  const resolve = (args) => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v in RELATIVE ? day(now(), RELATIVE[v]) : v]));

  return {
    file,
    learnable(text, { tool, output, asked }) {
      const key = phraseKey(text);
      if (!tool || asked || NEVER.test(tool) || !output || output.error) return false;
      if (key.split(' ').length < 2 || POINTS_BACK.test(key)) return false;
      if (QUESTION.test(key) && ACTION_TOOL.test(tool)) return false;
      return Boolean(replyFrom(output) || output.instructions);
    },
    learn(text, run) {
      if (!this.learnable(text, run)) return false;
      const args = template(run.args);
      if (!args) return false;
      const key = phraseKey(text);
      saved[key] = { tool: run.tool, args, said: String(text).trim().slice(0, 200), uses: saved[key]?.uses || 0, at: now().toISOString() };
      const keys = Object.keys(saved);
      if (keys.length > max) for (const k of keys.sort((a, b) => (saved[a].at < saved[b].at ? -1 : 1)).slice(0, keys.length - max)) delete saved[k];
      save();
      return true;
    },
    find(text) {
      const key = phraseKey(text);
      const s = saved[key];
      return s ? { key, tool: s.tool, args: resolve(s.args) } : null;
    },
    used(key) {
      if (!saved[key]) return;
      saved[key].uses += 1;
      saved[key].lastUsed = now().toISOString();
      save();
    },
    forget(key) {
      if (!saved[key]) return false;
      delete saved[key];
      save();
      return true;
    },
    list() {
      return Object.entries(saved).map(([key, s]) => ({ key, ...s })).sort((a, b) => b.uses - a.uses || (a.at < b.at ? 1 : -1));
    },
  };
}
