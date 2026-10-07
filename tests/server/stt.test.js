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

  it('uses .wav for voice-detected 16 kHz recordings', async () => {
    let body;
    await transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav', keys: ['k'], fetchImpl: async (u, i) => { body = i.body; return new Response('{"text":"x"}'); } });
    expect(body.get('file').name).toBe('speech.wav');
  });

  it('retries as English when Whisper guesses a language Novi does not use', async () => {
    const bodies = [];
    const fetchImpl = async (u, i) => {
      bodies.push(i.body);
      return bodies.length === 1
        ? new Response(JSON.stringify({ text: 'Ваш да ведър им пъне.', language: 'bulgarian' }))
        : new Response(JSON.stringify({ text: "What's the weather in Pune?", language: 'english' }));
    };
    expect(await transcribe({ audio: Buffer.from('a'), keys: ['k'], fetchImpl })).toBe("What's the weather in Pune?");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].get('language')).toBeNull();
    expect(bodies[1].get('language')).toBe('en');
  });

  it('keeps Hindi and Marathi as heard', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ text: 'नोवी, अभी कितने बजे हैं?', language: 'hindi' })); };
    expect(await transcribe({ audio: Buffer.from('a'), keys: ['k'], fetchImpl })).toBe('नोवी, अभी कितने बजे हैं?');
    expect(calls).toBe(1);
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

  it("can use another model and vocabulary hint (for the benchmark), with today's as defaults", async () => {
    const forms = [];
    const fetchImpl = async (u, i) => { forms.push(i.body); return new Response('{"text":"x","language":"english"}'); };
    await transcribe({ audio: Buffer.from('a'), keys: ['k'], fetchImpl });
    await transcribe({ audio: Buffer.from('a'), keys: ['k'], fetchImpl, model: 'whisper-large-v3', prompt: 'Hey Novi. LeetCode.' });
    await transcribe({ audio: Buffer.from('a'), keys: ['k'], fetchImpl, prompt: '' });
    expect(forms[0].get('model')).toBe('whisper-large-v3-turbo');
    expect(forms[0].get('prompt')).toMatch(/Novi Coder/);
    expect(forms[1].get('model')).toBe('whisper-large-v3');
    expect(forms[1].get('prompt')).toBe('Hey Novi. LeetCode.');
    expect(forms[2].get('prompt')).toBeNull();
  });
});

