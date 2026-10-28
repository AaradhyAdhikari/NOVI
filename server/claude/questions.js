// Claude's own questions (AskUserQuestion) by voice: what Novi says, and which option the user's
// words pick. No AI — whole-utterance rules, so "make it dark" stays the user's own answer.
const SPOKEN_NUMBERS = ['One', 'Two', 'Three', 'Four'];
const NUMBER = new Map([
  ...['one', '1', 'first', 'pehla', 'pehli', 'ek', 'pahila'].map((w) => [w, 0]),
  ...['two', '2', 'second', 'doosra', 'doosri', 'dusra', 'dusri', 'do'].map((w) => [w, 1]),
  ...['three', '3', 'third', 'teesra', 'teesri', 'tisra', 'teen'].map((w) => [w, 2]),
  ...['four', '4', 'fourth', 'chautha', 'char', 'chaar'].map((w) => [w, 3]),
  ...['last', 'aakhri', 'akhri'].map((w) => [w, -1]),
]);
const FILLER = new Set(['the', 'option', 'number', 'wala', 'vala', 'wali', 'vali', 'please', 'plz', 'one']);
const SKIP = /^(?:skip|skip it|cancel|chhodo|chodo|rehne do|rahne do|koi bhi nahi|none|kuch nahi)$/;
const norm = (s) => String(s || '').toLowerCase().replace(/[.,!?।]+/g, ' ').replace(/\s+/g, ' ').trim();

export function spokenQuestion({ question, options = [] }) {
  const q = String(question || '').trim().replace(/[?.!]+$/, '');
  const list = options.slice(0, 4).map((o, i) => ` ${SPOKEN_NUMBERS[i]}, ${String(o.label).trim()}.`).join('');
  return `Claude asks: ${q}?${list}`;
}

// One part of an answer → option index, or null when the words don't clearly name one option.
function pickOne(part, options) {
  const words = part.split(' ').filter(Boolean);
  const numbers = words.filter((w) => NUMBER.has(w) && w !== 'one');
  const index = numbers.length ? NUMBER.get(numbers[0]) : words.includes('one') ? 0 : null;
  if (index !== null) {
    const rest = words.filter((w) => !NUMBER.has(w) && !FILLER.has(w));
    if (new Set(numbers.map((w) => NUMBER.get(w))).size > 1) return null;
    const i = index === -1 ? options.length - 1 : index;
    if (i >= options.length) return null;
    // Other words only when they are that option's own name ("One Bhashini", as Novi reads it out).
    if (rest.length && rest.join(' ') !== norm(options[i].label)) return null;
    return i;
  }
  const said = words.filter((w) => !FILLER.has(w)).join(' ');
  const labels = options.map((o) => norm(o.label));
  const whole = labels.indexOf(said);
  if (whole >= 0) return whole;
  // A word that belongs to only one option ("blue" → "Ocean blue"); every word said must be in it.
  const owners = labels.map((l, i) => (said && said.split(' ').every((w) => w.length >= 3 && l.split(' ').includes(w)) ? i : -1)).filter((i) => i >= 0);
  return owners.length === 1 ? owners[0] : null;
}

// The option the words name — { index } — or the options a word fits ("dark" → Dark mode, Dark blue):
// { ambiguous: [i, …] }; null when the words don't point at an option. Used for every card
// (server/brain/approvalIntent.js).
export function optionMatch(text, options = []) {
  const t = norm(text);
  if (!t || !options.length) return null;
  const one = pickOne(t, options);
  if (one !== null) return { index: one };
  const said = t.split(' ').filter((w) => w && !FILLER.has(w) && !NUMBER.has(w));
  if (!said.length || said.some((w) => w.length < 3)) return null;
  const owners = options.map((o, i) => (said.every((w) => norm(o.label).split(' ').includes(w)) ? i : -1)).filter((i) => i >= 0);
  return owners.length > 1 ? { ambiguous: owners } : null;
}

export function matchAnswer(text, options = [], { multiSelect = false } = {}) {
  const t = norm(text);
  if (SKIP.test(t)) return { kind: 'skip' };
  const parts = multiSelect ? t.split(/\s*(?:\band\b|\baur\b|&)\s*/).filter(Boolean) : [t];
  const picked = parts.map((p) => pickOne(p, options));
  if (!t || picked.some((i) => i === null)) return { kind: 'own', text: String(text).trim() };
  return { kind: 'option', labels: [...new Set(picked)].map((i) => options[i].label) };
}

export function answerFor(match) {
  if (match.kind === 'option') return match.labels.join(', ');
  return match.kind === 'own' ? match.text : '';
}
