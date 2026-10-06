// "Hey Novi" detection for hands-free mode. Pure logic, so it can be tested without a browser.

// Speech recognisers spell "Novi" many ways (novey, nobi, navy, nowy…), so match by sound:
// n + vowel(s) + v/b/w + vowel(s), as a whole word ("novel", "never", "nobody", "now" don't match).
const NAME = '(?:n[aeiou]{1,2}[vbw][aeiouy]{1,2}|movie)';
// Right after a greeting, anywhere in the phrase ("okay so hey Novey …", "heynovi …").
const GREETING_RE = new RegExp(`\\b(?:hey|hi|hay|ok|okay|hello)[\\s,]*${NAME}\\b[\\s,.!?]*(.*)$`, 'i');
// Name alone at the start needs a pause after it ("Novi, open …"), so "Navy ships …" is ignored.
const BARE_RE = new RegExp(`^${NAME}(?:[,!?.]\\s*(.*)|$)`, 'i');

// { command } when the text starts with the wake word ("" if nothing followed), otherwise null.
export function parseWake(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = GREETING_RE.exec(t) || BARE_RE.exec(t);
  return m ? { command: (m[1] || '').trim() } : null;
}

// True when Novi just asked the user something, so it should listen for the answer.
export function expectsAnswer(text) {
  return /\?\s*$/.test(String(text || '')) || /\b(should i allow it|shall i start|say yes|which account)\b/i.test(String(text || ''));
}

// Decides which recognised phrases are meant for Novi:
// "Hey Novi <command>", the phrase right after a bare "Hey Novi", or an answer inside a follow-up window.
export class WakeListener {
  constructor({ followUpMs = 8000, now = () => Date.now() } = {}) {
    this.followUpMs = followUpMs;
    this.now = now;
    this.until = 0;
  }

  openFollowUp(ms = this.followUpMs) {
    this.until = this.now() + ms;
  }

  get listening() {
    return this.now() < this.until;
  }

  handle(transcript) {
    const text = String(transcript || '').trim();
    if (!text) return null;
    const wake = parseWake(text);
    if (wake) {
      if (wake.command) {
        this.until = 0;
        return { command: wake.command };
      }
      this.openFollowUp();
      return { wake: true };
    }
    if (this.listening) {
      this.until = 0;
      return { command: text };
    }
    return null;
  }
}
