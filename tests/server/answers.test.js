import { describe, it, expect } from 'vitest';
import { answerKind } from '../../server/brain/answers.js';

// What people actually say (and what speech-to-text writes) when Novi asks "Allow this?"
describe('answerKind (only used while Novi is waiting for a yes / no)', () => {
  it('approve', () => {
    for (const t of ['Allow.', 'allow it', 'A low.', 'Aloe', 'alow', 'yes', 'Yes please', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'okay do it', 'sure', 'go ahead', 'do it', 'approve', 'approved', 'proceed', 'continue', 'confirm', 'fine', 'alright', 'haan', 'haan kar do', 'ha', 'han ji', 'theek hai', 'chalo', 'kar do', 'हाँ', 'हां ठीक है', 'हो', 'चालेल', 'yes Novi', 'hey Novi yes'])
      expect(answerKind(t), t).toBe('approve');
  });

  it('always allow', () => {
    for (const t of ['always allow', 'Always.', 'allow always', 'yes always', 'all ways', 'always a low', 'hamesha', 'hamesha allow karo', 'every time'])
      expect(answerKind(t), t).toBe('approve-always');
  });

  it('deny', () => {
    for (const t of ['no', 'Nay.', 'nah', 'nope', 'na', 'naa', 'deny', 'Denied.', 'Dino', 'Denny', 'decline', 'reject it', 'block it', "don't", "don't allow", 'do not', 'nahi', 'nahin', 'mat karo', 'nako', 'नहीं', 'नको', 'no thanks'])
      expect(answerKind(t), t).toBe('deny');
  });

  it('leaves anything else to the brain (or to stop / cancel)', () => {
    for (const t of ["what's the weather", 'open youtube', 'yes but use cursor instead of claude please', 'no wait allow it', 'cancel', 'stop', 'hello', ''])
      expect(answerKind(t), t).toBeNull();
  });
});

describe('speech hint while a question is waiting', async () => {
  const { answerHint } = await import('../../server/brain/answers.js');
  it('tells speech-to-text to expect yes / no / allow / deny only while Novi is asking', () => {
    expect(answerHint('Hey Novi.', false)).toBe('Hey Novi.');
    expect(answerHint('Hey Novi.', true)).toBe('Hey Novi. Yes. No. Allow. Deny. Always allow. Haan. Nahi.');
  });
});
