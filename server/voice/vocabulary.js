// Your word list (Settings → Words, data/vocabulary.json):
//   words — names Novi should expect; added to the speech-to-text hint.
//   fixes — "if I hear X, it means Y", applied to the transcript as whole words, any case.
import fs from 'node:fs';
import path from 'node:path';

const MAX_WORDS = 60;
const MAX_FIXES = 100;
const MAX_LEN = 40;
// Speech-to-text often hears "Claude" as "cloud" ("open cloud" opened Google Cloud). Fixed unless it
// clearly means the cloud: Google/Azure/AWS cloud, "the cloud", cloud storage/console/…
const CLAUDE_HEARD = /(?<!\p{L})(?<!(?:google|azure|aws|microsoft|oracle|ibm|the|sound|word|point|tag)\s+)(?:cloud|clod|clawed|claud|clowd|klaud)(?!\p{L})(?!\s+(?:storage|console|platform|run|functions?|drive|servers?|services?|computing|gaming|backup|sync|account|billing))/giu;
// "Claude" heard as "claw" (word-accuracy run 2026-10-21: "Ask CLAW to…") — only right after a command word.
const CLAW_HEARD = /(?<=(?<!\p{L})(?:ask|tell|use|in|on|to|with)\s+)claw(?!\p{L})/giu; // never after "open": "open claw" = OpenClaw
export const fixClaude = (text) => String(text).replace(CLAUDE_HEARD, 'Claude').replace(CLAW_HEARD, 'Claude');
// "C language" heard as "sea / see / si language"; C++ and C# the same way.
const C_HEARD = /(?<!\p{L})(?:sea|see|si|cee|c)\s+(?:plus\s+plus|\+\+)(?!\p{L})/giu;
const CSHARP_HEARD = /(?<!\p{L})(?:sea|see|si|cee|c)\s+sharp(?!\p{L})/giu;
const CLANG_HEARD = /(?<!\p{L})(?:sea|see|si|cee)\s+(language|programming|lang)(?!\p{L})/giu;
export const fixLanguages = (text) => String(text).replace(C_HEARD, 'C++').replace(CSHARP_HEARD, 'C#').replace(CLANG_HEARD, 'C $1');
// "LeetCode" heard as "lead code / leet court / lit code / leak code" (live 2026-10-17); "lead code
// review" and the like stay as said.
const LEET_HEARD = /(?<!\p{L})(?:leet|lead|lit|leat|leed|lee|leek|leak|liet)[\s-]*(?:code|court|coat|kode|cod)(?!\p{L})(?!\s+(?:review\w*|owner|author|base|quality|change\w*))/giu;
export const fixLeetCode = (text) => String(text).replace(LEET_HEARD, 'LeetCode');
// "GitHub" heard as "Gidhub / git hub / get hub / githab" (live 2026-10-17).
const GITHUB_HEARD = /(?<!\p{L})(?:gid|git|get|geet|kit)[\s-]?(?:hub|hab|harb)(?!\p{L})/giu;
export const fixGitHub = (text) => String(text).replace(GITHUB_HEARD, 'GitHub');
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
    // extra: names Novi knows by herself (her projects), after the user's own words; ≤ 40 names in all.
    prompt: (base, extra = []) => {
      const all = [...new Set([...saved.words, ...extra.filter(Boolean)])].slice(0, 40);
      return all.length ? `${base} ${all.join(', ')}.` : base;
    },
    apply: (text) => fixGitHub(fixLeetCode(fixLanguages(fixClaude(pattern ? String(text).replace(pattern, (m) => saved.fixes[m.toLowerCase()] ?? m) : String(text))))),
  };
}
