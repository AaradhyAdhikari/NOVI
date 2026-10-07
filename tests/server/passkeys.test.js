import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Passkeys } from '../../server/passkeys.js';

// Fake SimpleWebAuthn: challenges are counted, responses echo the challenge they sign.
function fakeLib() {
  let n = 0;
  const calls = [];
  return {
    calls,
    generateRegistrationOptions: async (o) => { calls.push(['regOptions', o]); return { challenge: `reg${++n}` }; },
    verifyRegistrationResponse: async (o) => ({ verified: o.response.challenge === o.expectedChallenge, registrationInfo: { credential: { id: 'cred1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } }),
    generateAuthenticationOptions: async (o) => { calls.push(['authOptions', o]); return { challenge: `auth${++n}` }; },
    verifyAuthenticationResponse: async (o) => { calls.push(['verifyAuth', o]); return { verified: o.response.challenge === o.expectedChallenge && o.credential.id === 'cred1', authenticationInfo: { newCounter: 1 } }; },
  };
}

function make() {
  let t = 1_000_000;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-pk-')), 'passkeys.json');
  const lib = fakeLib();
  const pk = new Passkeys({ file, rpId: 'novi-laptop.tail1234.ts.net', origin: 'https://novi-laptop.tail1234.ts.net:3001', now: () => t, lib });
  return { pk, lib, file, advance: (ms) => { t += ms; } };
}

async function register(pk, deviceId = 'd1') {
  const opts = await pk.registrationOptions(deviceId);
  return pk.verifyRegistration(deviceId, { id: 'cred1', challenge: opts.challenge });
}

describe('Passkeys', () => {
  it('asks the phone for its own fingerprint/face (platform authenticator, user verification required)', async () => {
    const { pk, lib } = make();
    await pk.registrationOptions('d1');
    expect(lib.calls[0][1]).toMatchObject({ rpID: 'novi-laptop.tail1234.ts.net', authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' } });
  });

  it('registers a credential for that device only', async () => {
    const { pk } = make();
    expect(await register(pk)).toBe(true);
    expect(pk.has('d1')).toBe(true);
    expect(pk.has('d2')).toBe(false);
  });

  it('rejects a registration answering the wrong challenge', async () => {
    const { pk } = make();
    await pk.registrationOptions('d1');
    expect(await pk.verifyRegistration('d1', { id: 'cred1', challenge: 'forged' })).toBe(false);
    expect(pk.has('d1')).toBe(false);
  });

  it('confirms once for the approval it was asked for', async () => {
    const { pk, lib } = make();
    await register(pk);
    const opts = await pk.authOptions('d1', 'appr1');
    expect(lib.calls.find((c) => c[0] === 'authOptions')[1]).toMatchObject({ userVerification: 'required' });
    expect(await pk.verifyAuth('d1', 'appr1', { id: 'cred1', challenge: opts.challenge })).toBe(true);
    expect(await pk.verifyAuth('d1', 'appr1', { id: 'cred1', challenge: opts.challenge })).toBe(false);
  });

  it('refuses a confirmation for another approval or after 2 minutes', async () => {
    const { pk, advance } = make();
    await register(pk);
    const opts = await pk.authOptions('d1', 'appr1');
    expect(await pk.verifyAuth('d1', 'appr2', { id: 'cred1', challenge: opts.challenge })).toBe(false);
    const again = await pk.authOptions('d1', 'appr1');
    advance(2 * 60_000 + 1);
    expect(await pk.verifyAuth('d1', 'appr1', { id: 'cred1', challenge: again.challenge })).toBe(false);
  });

  it('a device without a passkey cannot confirm', async () => {
    const { pk } = make();
    await expect(pk.authOptions('d1', 'appr1')).rejects.toThrow();
    expect(await pk.verifyAuth('d1', 'appr1', { id: 'cred1', challenge: 'x' })).toBe(false);
  });

  it('forgets a removed device and survives a restart', async () => {
    const { pk, file, lib } = make();
    await register(pk);
    expect(new Passkeys({ file, rpId: 'x', origin: 'y', lib }).has('d1')).toBe(true);
    pk.removeDevice('d1');
    expect(new Passkeys({ file, rpId: 'x', origin: 'y', lib }).has('d1')).toBe(false);
  });
});
