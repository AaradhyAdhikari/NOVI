// Your word list (Settings → Words, data/vocabulary.json):
//   words — names Novi should expect; added to the speech-to-text hint.
//   fixes — "if I hear X, it means Y", applied to the transcript as whole words, any case.
import fs from 'node:fs';
import path from 'node:path';

const MAX_WORDS = 60;
const MAX_FIXES = 100;
const MAX_LEN = 40;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clean({ words = [], fixes = {} } = {}) {
  const w = [...new Set(words.map((x) => String(x).trim()).filter(Boolean))];
  const f = {};
  for (const [from, to] of Object.entries(fixes || {})) {
    const k = String(from).trim().toLowerCase();
    const v = String(to).trim();
    if (k && v) f[k] = v;
  }
  if (w.length > MAX_WORDS) throw new Error(`At most ${MAX_WORDS} words.`);
  if (Object.keys(f).length > MAX_FIXES) throw new Error(`At most ${MAX_FIXES} fixes.`);
  if ([...w, ...Object.keys(f), ...Object.values(f)].some((x) => x.length > MAX_LEN)) throw new Error(`Words and fixes must be ${MAX_LEN} characters or less.`);
  return { words: w, fixes: f };
}

export function createVocabulary({ file }) {
  let saved = { words: [], fixes: {} };
  try { saved = clean(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* none yet */ }
  let pattern = null;
  const build = () => {
    const keys = Object.keys(saved.fixes).sort((a, b) => b.length - a.length);
    // Whole words in any script: no letter or digit right before or after.
    pattern = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(${keys.map(escape).join('|')})(?![\\p{L}\\p{N}\\p{M}])`, 'giu') : null;
  };
  build();
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    build();
  };
  return {
    get: () => ({ words: [...saved.words], fixes: { ...saved.fixes } }),
    set(value) {
      saved = clean(value);
      write();
      return this.get();
    },
    addFix(from, to) {
      if (!String(from ?? '').trim() || !String(to ?? '').trim()) throw new Error('Give both the misheard words and the right ones.');
      return this.set({ words: saved.words, fixes: { ...saved.fixes, [from]: to } });
    },
    prompt: (base) => (saved.words.length ? `${base} ${saved.words.join(', ')}.` : base),
    apply: (text) => (pattern ? String(text).replace(pattern, (m) => saved.fixes[m.toLowerCase()] ?? m) : String(text)),
  };
}
