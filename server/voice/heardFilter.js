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
  'haan', 'ha', 'han', 'nahi', 'nako', 'ho', 'theek', 'ruko', 'bas', 'deny', 'allow', 'always', 'continue', 'next', 'louder', 'quieter',
  'enter', 'send', 'bhejo']);

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

// A one-word answer gives the voice check little to go on, so an ordinary card gets a little slack. Anything
// riskier keeps the full check (and needs its PIN or a tap anyway).
const CARD_SLACK = 0.08;
export const cardSlack = (pending = []) => (pending.length && pending.every((a) => a.tier !== 'high' && !a.pin && !a.kind) ? CARD_SLACK : 0);

// The voice was learned on the laptop mic, and a phone sounds different (live: a real clip scored 0.568 against
// 0.57). A paired phone is already trusted, so its check is a little easier, unless a riskier card waits.
const PHONE_SLACK = 0.05;
// The phone that opened the remote view with the PIN is trusted by voice while it watches (user, 2026-11-08:
// through the phone mic their voice scored 0.50-0.54, under the pass mark). A strict card still checks.
export const trustedByPin = (pending = [], viewing = false) => Boolean(viewing) && !pending.some((a) => a.tier === 'high' || a.pin || a.kind);

export const voiceSlack = (pending = [], from = 'local') => {
  if (pending.some((a) => a.tier === 'high' || a.pin || a.kind)) return 0;
  return Math.max(cardSlack(pending), from === 'local' ? 0 : PHONE_SLACK);
};
