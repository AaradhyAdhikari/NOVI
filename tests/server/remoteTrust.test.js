import { describe, it, expect } from 'vitest';
import { requiredProof, createRemoteTrust } from '../../server/remoteTrust.js';

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

describe('pin approvals (dangerous laptop commands): the voice PIN on every device', () => {
  const phone = { deviceId: 'p1' };
  it('needs the PIN from the laptop too, and from a phone', () => {
    expect(requiredProof({ tier: 'medium', pin: true }, 'local')).toBe('pin');
    expect(requiredProof({ tier: 'medium', pin: true }, phone)).toBe('pin');
    expect(requiredProof({ tier: 'medium' }, 'local')).toBe(null);
  });
  it('no PIN set → refused with need "no-pin"; a right PIN → ok', () => {
    const none = createRemoteTrust({ pin: () => true, hasPin: () => false });
    expect(none.check({ tier: 'medium', pin: true }, 'local', { pin: '1234' })).toEqual({ ok: false, need: 'no-pin' });
    const set = createRemoteTrust({ pin: (p) => p.pin === '1234', hasPin: () => true });
    expect(set.check({ tier: 'medium', pin: true }, 'local', { pin: '1234' })).toEqual({ ok: true });
    expect(set.check({ tier: 'medium', pin: true }, 'local', { pin: '0000' })).toEqual({ ok: false, need: 'pin' });
    expect(set.check({ tier: 'medium', pin: true }, 'local')).toEqual({ ok: false, need: 'pin' });
  });
});
