// Dictation clean-up (user, 2026-11-03: "build what Infina does" — original code, ideas only).
// Rules only, no AI, instant: drops "um/uh", repeated words, tidies spaces, capitalises sentences.
// Used on hold-to-talk dictation, never on "type: …" (that stays exactly as said).
// Never adds an ending full stop (search boxes, chat drafts) and leaves non-Latin text alone.
const L = '\\p{L}';
const FILLER = new RegExp(`(?<!${L})(?:u+h+m*|u+m+|e+r+m*|a+h+m+|h+m+|m+h*m+)(?!${L})[,.]?\\s*`, 'giu');
const YOU_KNOW = /,\s*you know,\s*/gi; // only when set off by commas
// Said twice on purpose in everyday English; every other doubled word is a stutter.
const DOUBLE_OK = new Set(['had', 'that', 'is', 'do', 'no', 'bye', 'very', 'so', 'now', 'ha', 'hai', 'kya', 'bahut', 'aur']);
const SPOKEN = [ // punctuation first, then breaks, so a break is never eaten by the spaces around a mark
  [/\s*(?:question mark)\s*/gi, '? '],
  [/\s*(?:exclamation (?:mark|point))\s*/gi, '! '],
  [/\s*(?:full stop)\s*/gi, '. '],
  [/\s*(?:comma)\s*/gi, ', '],
  [/[ \t]*(?:new paragraph)[ \t]*/gi, '\n\n'],
  [/[ \t]*(?:new line|next line)[ \t]*/gi, '\n'],
];

export function cleanDictation(text, { fillers = true, stutters = true, capitalize = true, spokenPunctuation = false } = {}) {
  let t = String(text ?? '');
  if (spokenPunctuation) for (const [re, to] of SPOKEN) t = t.replace(re, to);
  if (fillers) t = t.replace(YOU_KNOW, ', ').replace(FILLER, ' ');
  if (stutters) {
    t = t.replace(new RegExp(`(?<!${L})(${L}+)(?:[\\s,]+\\1)+(?!${L})`, 'giu'), (m, w) => (DOUBLE_OK.has(w.toLowerCase()) ? m : w));
  }
  t = t.replace(/[ \t]+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/([,.!?;:])(?=[\p{L}])/gu, '$1 ').replace(/ ?\n ?/g, '\n').replace(/^[,.;:\s]+/, '').trim();
  if (capitalize) {
    t = t.replace(/(?<![\p{L}\p{N}'’])i(?=$|[\s'’,.!?;:])/gu, 'I'); // the pronoun "I" (not "i" in other words)
    t = t.replace(/^(\p{Ll})/u, (c) => c.toUpperCase()).replace(/([.!?]\s+|\n)(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase());
  }
  return t;
}
