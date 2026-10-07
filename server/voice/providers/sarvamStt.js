// Indian-language speech-to-text (Sarvam AI): much better than Whisper for Marathi and Hindi.
// Paid per hour of audio after the sign-up credits, so Novi uses it only where it helps
// (Hindi / Marathi / unsure Whisper results) and as the backup when Groq is down.
const URL = 'https://api.sarvam.ai/speech-to-text';
const CODES = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };

export function createSarvamStt({ keys = [], fetchImpl = fetch, model = 'saaras:v4', mode } = {}) {
  return {
    id: 'sarvam',
    available: () => keys.length > 0,
    async transcribe({ audio, mimeType = 'audio/wav', language }) {
      if (!keys.length) throw new Error('No Sarvam key configured for speech-to-text');
      const type = String(mimeType).split(';')[0];
      const filename = type.includes('wav') ? 'speech.wav' : type.includes('mp4') ? 'speech.mp4' : 'speech.webm';
      let lastError;
      for (const key of keys) {
        const form = new FormData();
        form.append('file', new Blob([audio], { type }), filename);
        form.append('model', model);
        form.append('language_code', CODES[language] || 'unknown');
        if (mode) form.append('mode', mode);
        let res;
        try {
          res = await fetchImpl(URL, { method: 'POST', headers: { 'api-subscription-key': key }, body: form, signal: AbortSignal.timeout(30_000) });
        } catch (err) {
          lastError = err;
          continue;
        }
        if (res.ok) return String((await res.json()).transcript || '').trim();
        lastError = new Error(`Sarvam speech-to-text failed (${res.status})`);
        if (![401, 402, 403, 429].includes(res.status) && res.status < 500) break;
      }
      throw lastError;
    },
  };
}
