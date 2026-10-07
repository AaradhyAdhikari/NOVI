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
