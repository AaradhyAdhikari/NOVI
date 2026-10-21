// Should Novi act on words the laptop mic heard? (live 2026-10-20: after each reply the mic kept
// listening and acted on noise — "Aung!" ran a sync, "Nombardum, Tzadak." and "Thank you." got
// answers, and every answer opened the mic again). Whisper's own confidence (avg_logprob) on the
// saved clips: real commands −0.19…−0.55, noise −0.86…−1.23. Returns why to drop it, or null.
const FOLLOW_UP_MIN = -0.75; // no "Hey Novi" before it: be strict
const WAKE_MIN = -1.1; // right after "Hey Novi": only drop real guesses

// What Whisper makes up from near-silence and background sound.
const PHANTOM = new Set(['thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching',
  'you', 'bye', 'bye bye', 'all right', 'alright', 'again', 'so', 'hmm', 'mm', 'uh', 'um', 'oh', 'ah', 'subscribe',
  'please subscribe', 'like and subscribe', 'the end', 'music', 'applause', 'laughter']);
// One word is fine when it is an answer or a stop.
const ONE_WORD_OK = new Set(['yes', 'yeah', 'yep', 'no', 'nope', 'nah', 'okay', 'ok', 'stop', 'cancel', 'wait', 'pause',
  'haan', 'ha', 'han', 'nahi', 'nako', 'ho', 'theek', 'ruko', 'bas', 'deny', 'allow', 'always', 'continue', 'next', 'louder', 'quieter']);

const clean = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

export function judgeHeard({ text, confidence, followUp = false } = {}) {
  const words = clean(text);
  if (!words) return 'nothing heard';
  if (typeof confidence === 'number' && confidence < (followUp ? FOLLOW_UP_MIN : WAKE_MIN)) return `unsure (${confidence.toFixed(2)})`;
  if (!followUp) return null;
  if (PHANTOM.has(words)) return 'made up from silence';
  if (!words.includes(' ') && !ONE_WORD_OK.has(words)) return 'one word that is not an answer';
  return null;
}
