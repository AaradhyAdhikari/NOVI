// Backup speech-to-text: Gemini listens to the clip on the free GEMINI_API_KEYS.
const MODEL = 'gemini-flash-latest';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const SILENCE = /^\[?\(?(silence|no speech|inaudible|blank audio)[^\])]*[\])]?\.?$/i;

const instruction = (language) => [
  'Transcribe this audio exactly as spoken, word for word.',
  'It is a person talking to their assistant "Novi" in English, Hindi, Marathi or a mix (Hinglish).',
  language ? `The expected language is "${language}".` : '',
  'Write Hindi and Marathi words in the script they were spoken in. Do not translate, answer, or add anything.',
  'If nobody speaks, reply with exactly: [silence]',
].filter(Boolean).join(' ');

export function createGeminiStt({ keys = [], fetchImpl = fetch } = {}) {
  return {
    id: 'gemini',
    available: () => keys.length > 0,
    async transcribe({ audio, mimeType = 'audio/webm', language }) {
      if (!keys.length) throw new Error('No Gemini key configured for speech-to-text');
      const body = JSON.stringify({
        contents: [{ parts: [
          { text: instruction(language) },
          { inline_data: { mime_type: String(mimeType).split(';')[0], data: Buffer.from(audio).toString('base64') } },
        ] }],
        generationConfig: { temperature: 0 },
      });
      let lastError;
      for (const key of keys) {
        let res;
        try {
          res = await fetchImpl(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(30_000) });
        } catch (err) {
          lastError = err;
          continue;
        }
        if (res.ok) {
          const data = await res.json();
          const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
          return SILENCE.test(text) ? '' : text;
        }
        lastError = new Error(`Gemini speech-to-text failed (${res.status})`);
        if (![401, 403, 429].includes(res.status) && res.status < 500) break;
      }
      throw lastError;
    },
  };
}
