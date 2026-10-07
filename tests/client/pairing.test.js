import { describe, it, expect } from 'vitest';
import { deviceName, pairCodeFromHash } from '../../src/lib/pairing.js';

describe('pairing helpers', () => {
  it('reads the one-time code from the QR link', () => {
    expect(pairCodeFromHash('#pair=123456')).toBe('123456');
    expect(pairCodeFromHash('#other')).toBeNull();
    expect(pairCodeFromHash('#pair=12ab')).toBeNull();
  });
  it('names the phone from its browser', () => {
    expect(deviceName('Mozilla/5.0 (Linux; Android 15; SM-S926B) AppleWebKit/537.36 Mobile')).toBe('Samsung SM-S926B');
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile')).toBe('Android phone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Browser');
  });
});
