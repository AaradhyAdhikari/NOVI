import { describe, it, expect } from 'vitest';
import { createEdgeTts, pickVoice } from '../../server/voice/edgeTts.js';

describe('Edge TTS voice choice', () => {
  it('uses Indian English for Latin script, Hindi or Marathi for Devanagari', () => {
    expect(pickVoice('Good morning! It is 24 degrees.')).toBe('en-IN-NeerjaNeural');
    expect(pickVoice('नमस्ते! आज पुणे में मौसम साफ़ है।')).toBe('hi-IN-SwaraNeural');
    expect(pickVoice('नमस्कार! आज पुण्यात हवामान स्वच्छ आहे.')).toBe('mr-IN-AarohiNeural');
    expect(pickVoice('मला उद्या सकाळी उठव, किती वाजले?')).toBe('mr-IN-AarohiNeural');
    expect(pickVoice('मुझे कल सुबह उठा देना, क्या आप कर सकते हैं?')).toBe('hi-IN-SwaraNeural');
  });

  it('lets .env choose other voices', () => {
    const voices = { en: 'en-IN-PrabhatNeural', hi: 'hi-IN-MadhurNeural', mr: 'mr-IN-ManoharNeural' };
    expect(pickVoice('hello', voices)).toBe('en-IN-PrabhatNeural');
    expect(pickVoice('यह है', voices)).toBe('hi-IN-MadhurNeural');
    expect(pickVoice('हे आहे', voices)).toBe('mr-IN-ManoharNeural');
  });
});

describe('Edge TTS synthesis', () => {
  it('returns MP3 audio from the chosen voice, trimming long text', async () => {
    const calls = [];
    const tts = createEdgeTts({ synthesize: async (voice, text) => { calls.push({ voice, text }); return Buffer.from('MP3'); } });
    expect(await tts('Hello there')).toEqual(Buffer.from('MP3'));
    expect(calls[0]).toEqual({ voice: 'en-IN-NeerjaNeural', text: 'Hello there' });
    await tts('x'.repeat(5000));
    expect(calls[1].text.length).toBe(1500);
  });

  it('refuses empty text and passes failures on (callers fall back to the local voice)', async () => {
    const tts = createEdgeTts({ synthesize: async () => { throw new Error('blocked'); } });
    await expect(tts('   ')).rejects.toThrow(/Nothing to say/);
    await expect(tts('hi')).rejects.toThrow(/blocked/);
  });

  it('gives up after a timeout instead of hanging', async () => {
    const tts = createEdgeTts({ timeoutMs: 50, synthesize: () => new Promise(() => {}) });
    await expect(tts('hi')).rejects.toThrow(/timed out/);
  });
});
