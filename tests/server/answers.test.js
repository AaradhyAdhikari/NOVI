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

describe('spokenApproval (only the task, in a few words)', async () => {
  const { spokenApproval } = await import('../../server/brain/answers.js');
  it('says the tool\'s short line, or the title cut to ~10 words, without "OK?"', () => {
    expect(spokenApproval({ title: 'Rename', prompt: 'Rename A to B. OK?', tier: 'medium' })).toBe('Rename A to B.');
    expect(spokenApproval({ title: 'Claude wants to run: npm install --save express cors dotenv nodemon jest supertest', tier: 'medium' }))
      .toBe('Claude wants to run: npm install --save express cors dotenv.');
    expect(spokenApproval({ title: 'Click "New Project" in Claude', tier: 'medium' })).toBe('Click "New Project" in Claude.');
    // User's choice (2026-10-28): high risk can be approved by saying the PIN (or a tap on the card).
    expect(spokenApproval({ title: 'Delete the repo', tier: 'high' })).toBe('High risk: Delete the repo. Say your PIN to approve, or say no.');
    // Deletes / payments still need the screen (fingerprint or the laptop).
    expect(spokenApproval({ title: 'Delete the repo', tier: 'high', kind: 'delete' })).toBe('High risk: Delete the repo. Please confirm on screen.');
  });

  it('a card with choices reads them out by number', () => {
    expect(spokenApproval({ title: 'Who should build it?', tier: 'medium', choices: [{ id: 'novi-coder', label: 'Novi Coder' }, { id: 'claude', label: 'Claude Code' }] }))
      .toBe('Who should build it. Option 1, Novi Coder. Option 2, Claude Code.');
  });
});
