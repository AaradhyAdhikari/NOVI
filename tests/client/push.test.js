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
