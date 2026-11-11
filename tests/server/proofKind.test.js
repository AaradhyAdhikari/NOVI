import { describe, it, expect } from 'vitest';
import { proofKind } from '../../src/lib/proofKind.js';

// Live 2026-11-11: fingerprint was set up on the phone, but the card inside the app's page still asked for the PIN.
describe('which proof a card asks for in the page', () => {
  it('a phone with fingerprint gets the fingerprint button instead of the PIN or passkey', () => {
    expect(proofKind({ pin: true }, true)).toBe('fingerprint');
    expect(proofKind({ need: 'pin' }, true)).toBe('fingerprint');
    expect(proofKind({ need: 'passkey' }, true)).toBe('fingerprint');
    expect(proofKind({ need: 'laptop' }, true)).toBe('fingerprint');
    expect(proofKind({ need: 'fingerprint' }, true)).toBe('fingerprint');
  });
  it('without fingerprint nothing changes', () => {
    expect(proofKind({ pin: true }, false)).toBe('pin');
    expect(proofKind({ need: 'passkey' }, false)).toBe('passkey');
    expect(proofKind({}, false)).toBe(null);
    expect(proofKind({}, true)).toBe(null);
  });
  it('no PIN set is still said as such', () => {
    expect(proofKind({ need: 'no-pin' }, false)).toBe('no-pin');
  });
});
