const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export async function transcribe({ audio, mimeType = 'audio/webm', keys, fetchImpl = fetch }) {
  if (!keys?.length) throw new Error('No Groq key configured for speech-to-text');
  const type = String(mimeType).split(';')[0];
  const filename = type.includes('mp4') || type.includes('m4a') ? 'speech.mp4' : 'speech.webm';
  let lastError;
  for (const key of keys) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type }), filename);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    // Vocabulary hint so Whisper spells Novi's names right instead of "Novey" etc.
    form.append('prompt', 'Hey Novi. Novi, Novi Coder, Claude, Groq, Gemini, GitHub, LeetCode, YouTube, Gmail.');
    let res;
    try {
      res = await fetchImpl(GROQ_STT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (res.ok) return String((await res.json()).text || '').trim();
    lastError = new Error(`Groq speech-to-text failed (${res.status})`);
    if (![401, 403, 429].includes(res.status) && res.status < 500) break;
  }
  throw lastError;
}
