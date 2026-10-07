import { describe, it, expect } from 'vitest';
import { requiredProof } from '../../server/remoteTrust.js';

const phone = { deviceId: 'd1' };

describe('requiredProof', () => {
  it('the laptop never needs extra proof', () => {
    expect(requiredProof({ tier: 'high', kind: 'delete' }, 'local', { hasPasskey: false })).toBeNull();
  });
  it('normal approvals from a phone need nothing extra', () => {
    expect(requiredProof({ tier: 'medium' }, phone, { hasPasskey: true })).toBeNull();
  });
  it('high-risk approvals from a phone need the voice PIN', () => {
    expect(requiredProof({ tier: 'high' }, phone, { hasPasskey: true })).toBe('pin');
  });
  it('deletes and payments from a phone need a passkey, or the laptop if none is set up', () => {
    expect(requiredProof({ tier: 'medium', kind: 'delete' }, phone, { hasPasskey: true })).toBe('passkey');
    expect(requiredProof({ tier: 'medium', kind: 'payment' }, phone, { hasPasskey: false })).toBe('laptop');
  });
  it('a high-risk delete needs the passkey (stronger than the PIN)', () => {
    expect(requiredProof({ tier: 'high', kind: 'delete' }, phone, { hasPasskey: true })).toBe('passkey');
  });
});
