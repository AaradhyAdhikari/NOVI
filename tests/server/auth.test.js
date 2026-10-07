import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pairing, isLocalAddress } from '../../server/auth.js';

function setup() {
  let t = 1_000_000;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-auth-')), 'devices.json');
  const pairing = new Pairing({ file, now: () => t });
  return { pairing, file, advance: (ms) => { t += ms; } };
}

describe('isLocalAddress', () => {
  it('accepts loopback only', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.20')).toBe(false);
  });
});

describe('Pairing', () => {
  it('issues a 6-digit code that rotates after 5 minutes', () => {
    const { pairing, advance } = setup();
    const { code } = pairing.currentCode();
    expect(code).toMatch(/^\d{6}$/);
    advance(5 * 60_000);
    expect(pairing.currentCode().code).not.toBe(code);
  });

  it('pairs with the right code once, returns a token that verifies and persists hashed', () => {
    const { pairing, file } = setup();
    const { code } = pairing.currentCode();
    const res = pairing.pair(code, 'Phone');
    expect(res.ok).toBe(true);
    expect(pairing.verify(res.token)).toMatchObject({ name: 'Phone' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain(res.token);
    expect(pairing.pair(code).ok).toBe(false);
    expect(new Pairing({ file }).verify(res.token)).not.toBeNull();
  });

  it('locks after 5 wrong attempts', () => {
    const { pairing, advance } = setup();
    for (let i = 0; i < 5; i++) expect(pairing.pair('000000x').ok).toBe(false);
    const { code } = pairing.currentCode();
    expect(pairing.pair(code)).toEqual({ ok: false, error: 'Too many attempts. Wait a minute.' });
    advance(60_001);
    expect(pairing.pair(pairing.currentCode().code).ok).toBe(true);
  });

  it('revokes devices', () => {
    const { pairing } = setup();
    const res = pairing.pair(pairing.currentCode().code);
    expect(pairing.listDevices()[0]).not.toHaveProperty('tokenHash');
    expect(pairing.revoke(res.deviceId)).toBe(true);
    expect(pairing.verify(res.token)).toBeNull();
  });

  it('rejects empty tokens', () => {
    expect(setup().pairing.verify('')).toBeNull();
  });
});

describe('Pairing.issue (no code: trusted Tailscale phone or laptop-approved request)', () => {
  it('adds a device and returns its token, which then verifies', () => {
    const { pairing } = setup();
    const { token, deviceId } = pairing.issue('Galaxy S24+', 'tailscale');
    expect(pairing.verify(token).id).toBe(deviceId);
    expect(pairing.listDevices()[0]).toMatchObject({ name: 'Galaxy S24+', via: 'tailscale' });
  });
});

