import { describe, it, expect } from 'vitest';
import { transcribe } from '../../server/voice/stt.js';

describe('transcribe', () => {
  it('posts audio to Groq Whisper and returns trimmed text', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: ' hello novi ' })); };
    const text = await transcribe({ audio: Buffer.from('abc'), mimeType: 'audio/webm', keys: ['k1'], fetchImpl });
    expect(text).toBe('hello novi');
    expect(seen.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(seen.init.headers.Authorization).toBe('Bearer k1');
    expect(seen.init.body.get('model')).toBe('whisper-large-v3-turbo');
    expect(seen.init.body.get('prompt')).toMatch(/Hey Novi/);
    expect(seen.init.body.get('file').name).toBe('speech.webm');
  });

  it('uses .mp4 for Safari recordings', async () => {
    let body;
    await transcribe({ audio: Buffer.from('a'), mimeType: 'audio/mp4', keys: ['k'], fetchImpl: async (u, i) => { body = i.body; return new Response('{"text":"x"}'); } });
    expect(body.get('file').name).toBe('speech.mp4');
  });

  it('tries the next key on 429', async () => {
    const used = [];
    const fetchImpl = async (u, i) => { used.push(i.headers.Authorization); return used.length === 1 ? new Response('{}', { status: 429 }) : new Response('{"text":"ok"}'); };
    expect(await transcribe({ audio: Buffer.from('a'), keys: ['k1', 'k2'], fetchImpl })).toBe('ok');
    expect(used).toEqual(['Bearer k1', 'Bearer k2']);
  });

  it('fails clearly without keys', async () => {
    await expect(transcribe({ audio: Buffer.from('a'), keys: [] })).rejects.toThrow(/No Groq key/);
  });
});
