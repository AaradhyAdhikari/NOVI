import { describe, it, expect } from 'vitest';
import { createGeminiVision } from '../../server/brain/vision.js';

const reply = (text, status = 200) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status });

describe('Gemini vision (screenshots)', () => {
  it('sends the image inline with the key in a header and returns the text', async () => {
    let seen;
    const vision = createGeminiVision({ keys: ['g1'], fetchImpl: async (url, init) => { seen = { url, init }; return reply(' A chat app. '); } });
    expect(await vision(Buffer.from('PNG'), 'What is on screen?')).toBe('A chat app.');
    expect(seen.url).not.toContain('g1');
    expect(seen.init.headers['x-goog-api-key']).toBe('g1');
    const parts = JSON.parse(seen.init.body).contents[0].parts;
    expect(parts).toEqual([{ text: 'What is on screen?' }, { inline_data: { mime_type: 'image/png', data: Buffer.from('PNG').toString('base64') } }]);
  });

  it('tries the next key on 429 and explains when no key is set', async () => {
    const used = [];
    const vision = createGeminiVision({ keys: ['a', 'b'], fetchImpl: async (u, i) => { used.push(i.headers['x-goog-api-key']); return used.length === 1 ? new Response('{}', { status: 429 }) : reply('ok'); } });
    expect(await vision(Buffer.from('x'), 'q')).toBe('ok');
    expect(used).toEqual(['a', 'b']);
    await expect(createGeminiVision({ keys: [] })(Buffer.from('x'), 'q')).rejects.toThrow(/GEMINI_API_KEYS/);
  });
});

// Live 2026-10-22: "Play the first video on screen" failed — "Gemini vision failed (503)" (overloaded),
// and the next try timed out. Overloaded Gemini → one quick retry, then Groq's image model.
describe('vision with a backup (Gemini busy → Groq)', () => {
  const groqReply = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  it('Gemini 503 twice → Groq (qwen image model) answers', async () => {
    const { createVision } = await import('../../server/brain/vision.js');
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(String(url));
      if (/googleapis/.test(url)) return new Response('{}', { status: 503 });
      const body = JSON.parse(init.body);
      expect(body.model).toBe('qwen/qwen3.8-27b');
      expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(init.headers.authorization).toBe('Bearer q1');
      return groqReply(' The Kick page. ');
    };
    const vision = createVision({ geminiKeys: ['g1'], groqKeys: ['q1'], fetchImpl, sleep: async () => {} });
    expect(await vision(Buffer.from('PNG'), 'What is on screen?')).toBe('The Kick page.');
    expect(calls.filter((u) => /googleapis/.test(u))).toHaveLength(2);
    expect(calls.filter((u) => /groq/.test(u))).toHaveLength(1);
  });
  it('Gemini fine → Groq never asked; no keys anywhere → says which keys are missing', async () => {
    const { createVision } = await import('../../server/brain/vision.js');
    const calls = [];
    const vision = createVision({ geminiKeys: ['g1'], groqKeys: ['q1'], fetchImpl: async (url) => { calls.push(String(url)); return reply('ok'); }, sleep: async () => {} });
    expect(await vision(Buffer.from('PNG'), 'x')).toBe('ok');
    expect(calls).toHaveLength(1);
    await expect(createVision({})(Buffer.from('PNG'), 'x')).rejects.toThrow(/GEMINI_API_KEYS or GROQ_API_KEYS/);
  });
});
