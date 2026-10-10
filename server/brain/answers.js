// What the user answers while Novi waits for a yes / no ("Allow this?"), the way people say it and the
// way speech-to-text writes it ("A low", "Nay", "Dino"), in English, Hinglish, Hindi and Marathi.
// Only short replies made entirely of these words count; anything else goes to the brain.
const PHRASES = [
  [/\b(?:don'?t|do not|mat|never) (?:allow|approve|do it)\b/g, 'deny'],
  [/\bdo not\b/g, 'dont'],
  [/\ba ?low\b|\ballo\b|\balow\b|\baloe\b|\ballowed\b/g, 'allow'],
  [/\ball ?ways\b|\bal ways\b|\bevery ?time\b|\bhar baar\b|\bhumesha\b/g, 'always'],
  [/\bgo ahead\b|\bdo it\b|\bkar do\b|\bkar de\b|\bkarlo\b|\bkar lo\b/g, 'yes'],
];
const STRONG_YES = new Set('yes yeah yep yup ya yah yas yess ok okay okey sure allow approve approved proceed continue confirm confirmed fine alright accept accepted haan haa han ha theek thik chalo chalega हाँ हां हा हो ठीक चालेल'.split(' '));
const WEAK_YES = new Set('do kar karo go'.split(' '));
const NO = new Set("no nope nay nah na naa deny denied dino denny deni dinah decline declined reject rejected block dont don't nahi nahin nai mat nako नहीं नही नको मत".split(' '));
const ALWAYS = new Set('always hamesha'.split(' '));
const FILLER = new Set('it this that please novi hey ji hai the request thanks thank you now है बस'.split(' '));

// → 'approve' | 'approve-always' | 'deny' | null
export function answerKind(text) {
  let t = String(text || '').toLowerCase().replace(/[.!?।,;:"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  const words = t.split(' ').filter(Boolean);
  if (words.length > 6) return null;
  let yes = false;
  let weak = false;
  let no = false;
  let always = false;
  for (const w of words) {
    if (STRONG_YES.has(w)) yes = true;
    else if (WEAK_YES.has(w)) weak = true;
    else if (NO.has(w)) no = true;
    else if (ALWAYS.has(w)) always = true;
    else if (!FILLER.has(w)) return null; // something else was said: let the brain handle it
  }
  if (no) return yes || always ? null : 'deny';
  if (always) return 'approve-always';
  return yes || weak ? 'approve' : null;
}

// Speech-to-text hint: while Novi is asking, expect the answer words (Whisper otherwise writes "Allow"
// as "Hello" or "A low").
export const answerHint = (base, waiting) => (waiting ? `${base} Yes. No. Allow. Deny. Always allow. Haan. Nahi.` : base);
