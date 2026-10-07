import { describe, it, expect } from 'vitest';
import { createSarvamStt } from '../../server/voice/providers/sarvamStt.js';

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

describe('Sarvam speech-to-text', () => {
  it('sends the clip with the key header, auto language by default, and returns the transcript', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return ok({ transcript: ' नोवी, आता किती वाजले? ', language_code: 'mr-IN' }); };
    const stt = createSarvamStt({ keys: ['K1'], fetchImpl });
    expect(stt.id).toBe('sarvam');
    expect(stt.available()).toBe(true);
    const out = await stt.transcribe({ audio: Buffer.from('wav'), mimeType: 'audio/wav' });
    expect(out).toBe('नोवी, आता किती वाजले?');
    expect(seen[0].url).toBe('https://api.sarvam.ai/speech-to-text');
    expect(seen[0].init.headers['api-subscription-key']).toBe('K1');
    const form = seen[0].init.body;
    expect(form.get('model')).toBe('saaras:v4');
    expect(form.get('language_code')).toBe('unknown');
    expect(form.get('file').name).toBe('speech.wav');
  });

  it('maps Novi languages to Sarvam codes and allows another model/mode', async () => {
    const forms = [];
    const fetchImpl = async (u, i) => { forms.push(i.body); return ok({ transcript: 'x' }); };
    await createSarvamStt({ keys: ['K'], fetchImpl }).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav', language: 'mr' });
    await createSarvamStt({ keys: ['K'], fetchImpl, model: 'saaras:v3', mode: 'codemix' }).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' });
    expect(forms[0].get('language_code')).toBe('mr-IN');
    expect(forms[1].get('model')).toBe('saaras:v3');
    expect(forms[1].get('mode')).toBe('codemix');
  });

  it('tries the next key on auth/limit errors, and says when credits run out', async () => {
    const keysTried = [];
    const fetchImpl = async (u, i) => { keysTried.push(i.headers['api-subscription-key']); return new Response('{}', { status: keysTried.length === 1 ? 429 : 403 }); };
    await expect(createSarvamStt({ keys: ['A', 'B'], fetchImpl }).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' })).rejects.toThrow(/Sarvam speech-to-text failed \(403\)/);
    expect(keysTried).toEqual(['A', 'B']);
    expect(createSarvamStt({ keys: [] }).available()).toBe(false);
  });
});
