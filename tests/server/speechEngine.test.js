import { describe, it, expect } from 'vitest';
import { createSpeechEngine } from '../../server/voice/speechEngine.js';
import { createGroqWhisperStt } from '../../server/voice/providers/groqWhisper.js';

const provider = (id, behaviour, available = true) => ({
  id,
  available: () => available,
  transcribe: async (input) => {
    if (behaviour instanceof Error) throw behaviour;
    return typeof behaviour === 'function' ? behaviour(input) : behaviour;
  },
});

describe('speech engine', () => {
  it('uses the first available provider and says which one answered', async () => {
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', 'hello novi'), provider('gemini', 'other')] });
    expect(await engine.transcribe({ audio: Buffer.from('a'), mimeType: 'audio/webm' }))
      .toEqual({ text: 'hello novi', provider: 'groq-whisper', fallbackFrom: [] });
  });

  it('falls back to the next provider when one fails', async () => {
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', new Error('429')), provider('gemini', 'hi')] });
    expect(await engine.transcribe({ audio: Buffer.from('a') }))
      .toEqual({ text: 'hi', provider: 'gemini', fallbackFrom: ['groq-whisper'] });
  });

  it('skips providers that have no keys', async () => {
    let called = false;
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', () => { called = true; return 'x'; }, false), provider('gemini', 'hi')] });
    expect((await engine.transcribe({ audio: Buffer.from('a') })).provider).toBe('gemini');
    expect(called).toBe(false);
  });

  it('treats silence (empty text) as an answer, not a failure', async () => {
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', ''), provider('gemini', 'made up')] });
    expect((await engine.transcribe({ audio: Buffer.from('a') })).text).toBe('');
  });

  it('passes audio, mime type and language through to the provider', async () => {
    let seen;
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', (i) => { seen = i; return 'x'; })] });
    await engine.transcribe({ audio: Buffer.from('a'), mimeType: 'audio/mp4', language: 'hi' });
    expect(seen).toMatchObject({ mimeType: 'audio/mp4', language: 'hi' });
  });

  it('reports every failure when all providers fail', async () => {
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', new Error('quota')), provider('gemini', new Error('down'))] });
    await expect(engine.transcribe({ audio: Buffer.from('a') })).rejects.toThrow(/groq-whisper: quota.*gemini: down/);
  });

  it('fails clearly when no provider has keys', async () => {
    const engine = createSpeechEngine({ stt: [provider('groq-whisper', 'x', false)] });
    await expect(engine.transcribe({ audio: Buffer.from('a') })).rejects.toThrow(/No speech-to-text provider/);
  });
});

describe('Groq Whisper provider', () => {
  it('is available only with keys and wraps Groq transcription', async () => {
    expect(createGroqWhisperStt({ keys: [] }).available()).toBe(false);
    const p = createGroqWhisperStt({ keys: ['k'], fetchImpl: async () => new Response('{"text":" yo "}') });
    expect(p.id).toBe('groq-whisper');
    expect(p.available()).toBe(true);
    expect((await p.transcribe({ audio: Buffer.from('a'), mimeType: 'audio/webm' })).text).toBe('yo');
  });

  it('adds your word list to the Whisper hint', async () => {
    let body;
    const p = createGroqWhisperStt({ keys: ['k'], prompt: (base) => `${base} OpenClaw.`, fetchImpl: async (u, i) => { body = i.body; return new Response('{"text":"x"}'); } });
    await p.transcribe({ audio: Buffer.from('a') });
    expect(body.get('prompt')).toMatch(/Hey Novi\..*OpenClaw\.$/);
  });

  it('sends the language hint to Whisper when one is given', async () => {
    let body;
    const p = createGroqWhisperStt({ keys: ['k'], fetchImpl: async (u, i) => { body = i.body; return new Response('{"text":"x"}'); } });
    await p.transcribe({ audio: Buffer.from('a'), language: 'hi' });
    expect(body.get('language')).toBe('hi');
  });

  describe('Hindi / Marathi go to the Indian-language provider', () => {
    it('re-sends a clip Whisper heard as Marathi or Hindi, letting Sarvam detect the language', async () => {
      const seen = [];
      const indic = provider('sarvam', (input) => { seen.push(input.language); return 'नोवी, आता किती वाजले?'; });
      const engine = createSpeechEngine({ stt: [provider('groq-whisper', { text: 'Novi. Now what is it?', language: 'marathi' })], indic });
      expect(await engine.transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' }))
        .toEqual({ text: 'नोवी, आता किती वाजले?', provider: 'sarvam', fallbackFrom: [], refinedFrom: 'groq-whisper' });
      expect(seen).toEqual([undefined]); // Whisper calls Marathi "Hindi" too often to pass it on
    });

    it('also re-sends clips where Whisper guessed a language Novi does not use (often Marathi)', async () => {
      const indic = provider('sarvam', 'उद्या पुण्यात हवामान कसं असेल?');
      const engine = createSpeechEngine({ stt: [provider('groq-whisper', { text: 'Uda Punaat Haman Kasa Hacen.', language: 'icelandic' })], indic });
      expect((await engine.transcribe({ audio: Buffer.from('a') })).text).toBe('उद्या पुण्यात हवामान कसं असेल?');
    });

    it('keeps English on Whisper (no extra paid call)', async () => {
      let calls = 0;
      const indic = provider('sarvam', () => { calls += 1; return 'x'; });
      const engine = createSpeechEngine({ stt: [provider('groq-whisper', { text: 'what time is it', language: 'english' })], indic });
      expect((await engine.transcribe({ audio: Buffer.from('a') })).text).toBe('what time is it');
      expect(calls).toBe(0);
    });

    it("keeps Whisper's text when the Indian-language provider fails or has no credits", async () => {
      const engine = createSpeechEngine({ stt: [provider('groq-whisper', { text: 'kal subah alarm', language: 'hindi' })], indic: provider('sarvam', new Error('Sarvam speech-to-text failed (402)')) });
      expect(await engine.transcribe({ audio: Buffer.from('a') })).toEqual({ text: 'kal subah alarm', provider: 'groq-whisper', fallbackFrom: [] });
    });

    it('is the backup when Whisper fails', async () => {
      const engine = createSpeechEngine({ stt: [provider('groq-whisper', new Error('503')), provider('sarvam', 'hello')], indic: provider('sarvam', 'never') });
      expect(await engine.transcribe({ audio: Buffer.from('a') })).toEqual({ text: 'hello', provider: 'sarvam', fallbackFrom: ['groq-whisper'] });
    });
  });

  it('the Groq provider reports the language Whisper heard', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ text: ' नमस्ते ', language: 'hindi' }));
    expect(await createGroqWhisperStt({ keys: ['k'], fetchImpl }).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' })).toEqual({ text: 'नमस्ते', language: 'hindi' });
  });
});

