// Understands images (screenshots for screen control) with Gemini's free vision model.
// The user agreed (2026-10-07) that screenshots may be sent to Gemini; Groq has no suitable vision model.
const MODEL = 'gemini-flash-latest';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export function createGeminiVision({ keys = [], fetchImpl = fetch } = {}) {
  return async (png, prompt) => {
    if (!keys.length) throw new Error('Screen understanding needs a Gemini key (GEMINI_API_KEYS in .env).');
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/png', data: Buffer.from(png).toString('base64') } }] }],
      generationConfig: { temperature: 0 },
    });
    let lastError;
    for (const key of keys) {
      let res;
      try {
        res = await fetchImpl(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      }
      lastError = new Error(`Gemini vision failed (${res.status})`);
      if (![401, 403, 429].includes(res.status) && res.status < 500) break;
    }
    throw lastError;
  };
}
