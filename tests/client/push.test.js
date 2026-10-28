import { describe, it, expect } from 'vitest';
import { keyToBytes, installHint } from '../../src/lib/push.js';

describe('push helpers', () => {
  it('turns the server key (base64url) into bytes for subscribe()', () => {
    expect([...keyToBytes('AQID-_8')]).toEqual([1, 2, 3, 251, 255]);
  });
  it('tells iPhone users to add Novi to the Home Screen first', () => {
    expect(installHint({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: false })).toMatch(/Add to Home Screen/);
    expect(installHint({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: true })).toBeNull();
    expect(installHint({ userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S926B)', standalone: false })).toBeNull();
  });
});

// The service worker answers a card from a notification button with the phone's own token (2026-10-28).
describe('shareToken', async () => {
  const { shareToken } = await import('../../src/lib/push.js');
  it('puts the token where the service worker reads it; no token removes it', async () => {
    const store = new Map();
    const caches = { open: async (name) => ({ put: async (k, r) => store.set(`${name}${k}`, await r.text()), delete: async (k) => store.delete(`${name}${k}`) }) };
    await shareToken('tok123', { caches, Response: class { constructor(t) { this.t = t; } async text() { return this.t; } } });
    expect(store.get('novi-auth/novi-token')).toBe('tok123');
    await shareToken(null, { caches });
    expect(store.has('novi-auth/novi-token')).toBe(false);
  });
});
