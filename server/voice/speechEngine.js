// One speech layer, many providers. Providers are tried in order; one without keys is
// skipped, one that fails hands over to the next.
// indic: an Indian-language provider (Sarvam). When the first provider heard Hindi or Marathi,
// the clip is sent there too and its text is used (Whisper is weak at both, Marathi especially;
// benchmark 2026-10-07: Marathi 97% → 25% word errors). English stays on the free provider.
// If it fails (e.g. credits used up), the first provider's text is kept.
// Anything Whisper didn't hear as English: Hindi, Marathi, or a wrong guess (Whisper often calls
// Marathi "Icelandic" or "Hindi"), so Sarvam detects the language itself.
const ENGLISH = new Set(['english', 'en']);
const asResult = (out) => (typeof out === 'string' ? { text: out } : { text: String(out?.text || ''), language: out?.language });

export function createSpeechEngine({ stt = [], indic = null } = {}) {
  return {
    async transcribe({ audio, mimeType, language }) {
      const ready = stt.filter((p) => p.available());
      if (!ready.length) throw new Error('No speech-to-text provider has a key configured');
      const failures = [];
      for (const p of ready) {
        let heard;
        try {
          heard = asResult(await p.transcribe({ audio, mimeType, language }));
        } catch (err) {
          failures.push({ id: p.id, message: err.message });
          continue;
        }
        const heardLanguage = String(heard.language || '').toLowerCase();
        if (heardLanguage && !ENGLISH.has(heardLanguage) && indic?.available() && indic.id !== p.id) {
          try {
            const better = asResult(await indic.transcribe({ audio, mimeType })).text.trim();
            if (better) return { text: better, provider: indic.id, fallbackFrom: failures.map((f) => f.id), refinedFrom: p.id };
          } catch { /* keep what the first provider heard */ }
        }
        return { text: heard.text, provider: p.id, fallbackFrom: failures.map((f) => f.id) };
      }
      throw new Error(`Speech-to-text failed: ${failures.map((f) => `${f.id}: ${f.message}`).join('; ')}`);
    },
  };
}
