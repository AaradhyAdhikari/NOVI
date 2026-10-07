import { describe, it, expect } from 'vitest';
import { createGeminiStt } from '../../server/voice/providers/geminiStt.js';

const reply = (text, status = 200) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status });

describe('Gemini speech-to-text provider', () => {
  it('is available only with keys', () => {
    expect(createGeminiStt({ keys: [] }).available()).toBe(false);
    expect(createGeminiStt({ keys: ['g'] }).available()).toBe(true);
  });

  it('sends the audio inline with the key in a header (never the URL) and returns trimmed text', async () => {
    let seen;
    const p = createGeminiStt({ keys: ['g1'], fetchImpl: async (url, init) => { seen = { url, init }; return reply(' hey novi \n'); } });
    expect(await p.transcribe({ audio: Buffer.from('abc'), mimeType: 'audio/webm;codecs=opus' })).toBe('hey novi');
    expect(seen.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[\w.-]+:generateContent$/);
    expect(seen.url).not.toContain('g1');
    expect(seen.init.headers['x-goog-api-key']).toBe('g1');
    const body = JSON.parse(seen.init.body);
    const parts = body.contents[0].parts;
    const audio = parts.find((x) => x.inline_data).inline_data;
    expect(audio).toEqual({ mime_type: 'audio/webm', data: Buffer.from('abc').toString('base64') });
    expect(parts.find((x) => x.text).text).toMatch(/transcri/i);
    expect(body.generationConfig.temperature).toBe(0);
  });

  it('mentions the language when one is given', async () => {
    let body;
    const p = createGeminiStt({ keys: ['g'], fetchImpl: async (u, i) => { body = JSON.parse(i.body); return reply('x'); } });
    await p.transcribe({ audio: Buffer.from('a'), language: 'hi' });
    expect(body.contents[0].parts.find((x) => x.text).text).toMatch(/hi/);
  });

  it('returns empty text for silence instead of a placeholder', async () => {
    const p = createGeminiStt({ keys: ['g'], fetchImpl: async () => reply('[silence]') });
    expect(await p.transcribe({ audio: Buffer.from('a') })).toBe('');
  });

  it('tries the next key on 429 and fails clearly when all keys fail', async () => {
    const used = [];
    const ok = createGeminiStt({ keys: ['a', 'b'], fetchImpl: async (u, i) => { used.push(i.headers['x-goog-api-key']); return used.length === 1 ? new Response('{}', { status: 429 }) : reply('ok'); } });
    expect(await ok.transcribe({ audio: Buffer.from('a') })).toBe('ok');
    expect(used).toEqual(['a', 'b']);
    const bad = createGeminiStt({ keys: ['a'], fetchImpl: async () => new Response('{}', { status: 500 }) });
    await expect(bad.transcribe({ audio: Buffer.from('a') })).rejects.toThrow(/Gemini speech-to-text failed \(500\)/);
  });
});
