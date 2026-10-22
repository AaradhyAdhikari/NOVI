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

// Groq's image model as the backup (live 2026-10-22: Gemini answered 503 "overloaded" and screen
// control was blind). Groq is the provider the user already trusts with private turns.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen/qwen3.8-27b';
export function createGroqVision({ keys = [], fetchImpl = fetch } = {}) {
  return async (png, prompt) => {
    const body = JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` } }] }],
    });
    let lastError;
    for (const key of keys) {
      let res;
      try {
        res = await fetchImpl(GROQ_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body, signal: AbortSignal.timeout(60_000) });
      } catch (err) { lastError = err; continue; }
      if (res.ok) {
        const data = await res.json();
        return String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
      lastError = new Error(`Groq vision failed (${res.status})`);
      if (![401, 403, 429].includes(res.status) && res.status < 500) break;
    }
    throw lastError || new Error('Groq vision has no key.');
  };
}

// Gemini first; overloaded (5xx) → one retry 1.5 s later; still failing → Groq.
export function createVision({ geminiKeys = [], groqKeys = [], fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gemini = geminiKeys.length ? createGeminiVision({ keys: geminiKeys, fetchImpl }) : null;
  const groq = groqKeys.length ? createGroqVision({ keys: groqKeys, fetchImpl }) : null;
  return async (png, prompt) => {
    if (!gemini && !groq) throw new Error('Screen understanding needs GEMINI_API_KEYS or GROQ_API_KEYS in .env.');
    let lastError;
    if (gemini) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await gemini(png, prompt); } catch (err) {
          lastError = err;
          if (!/\((5\d\d)\)|timeout|aborted/i.test(err.message)) break;
          if (attempt === 0) await sleep(1500);
        }
      }
    }
    if (groq) return groq(png, prompt);
    throw lastError;
  };
}
