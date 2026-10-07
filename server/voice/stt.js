const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Languages the user speaks. Whisper sometimes guesses another one on quiet or short audio
// (e.g. "what's the weather in Pune" came back as Bulgarian); then retry as English.
const EXPECTED_LANGUAGES = new Set(['english', 'hindi', 'marathi', 'en', 'hi', 'mr']);

export async function transcribe({ audio, mimeType = 'audio/webm', language, keys, fetchImpl = fetch }) {
  if (!keys?.length) throw new Error('No Groq key configured for speech-to-text');
  const first = await request({ audio, mimeType, language, keys, fetchImpl });
  if (language || !first.language || EXPECTED_LANGUAGES.has(String(first.language).toLowerCase())) return first.text;
  return (await request({ audio, mimeType, language: 'en', keys, fetchImpl })).text;
}

async function request({ audio, mimeType, language, keys, fetchImpl }) {
  const type = String(mimeType).split(';')[0];
  const filename = type.includes('wav') ? 'speech.wav' : type.includes('mp4') || type.includes('m4a') ? 'speech.mp4' : 'speech.webm';
  let lastError;
  for (const key of keys) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), filename);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json'); // includes the detected language
    if (language) form.append('language', language);
    // Vocabulary hint so Whisper spells Novi's names right instead of "Novey" etc.
    form.append('prompt', 'Hey Novi. Novi, Novi Coder, Claude, Groq, Gemini, GitHub, LeetCode, YouTube, Gmail.');
    let res;
    try {
      res = await fetchImpl(GROQ_STT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      return { text: String(data.text || '').trim(), language: data.language };
    }
    lastError = new Error(`Groq speech-to-text failed (${res.status})`);
    if (![401, 403, 429].includes(res.status) && res.status < 500) break;
  }
  throw lastError;
}
