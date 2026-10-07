// One speech layer, many providers. Providers are tried in order; one without keys is
// skipped, one that fails hands over to the next. Adding BHASHINI or Google Cloud later
// means adding a provider file, nothing else.
export function createSpeechEngine({ stt = [] } = {}) {
  return {
    async transcribe({ audio, mimeType, language }) {
      const ready = stt.filter((p) => p.available());
      if (!ready.length) throw new Error('No speech-to-text provider has a key configured');
      const failures = [];
      for (const p of ready) {
        try {
          const text = await p.transcribe({ audio, mimeType, language });
          return { text, provider: p.id, fallbackFrom: failures.map((f) => f.id) };
        } catch (err) {
          failures.push({ id: p.id, message: err.message });
        }
      }
      throw new Error(`Speech-to-text failed: ${failures.map((f) => `${f.id}: ${f.message}`).join('; ')}`);
    },
  };
}
