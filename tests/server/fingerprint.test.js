import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFingerprints, approveMessage } from '../../server/fingerprint.js';
import { createRemoteTrust } from '../../server/remoteTrust.js';

// User, 2026-11-11: fingerprint (later face) instead of the PIN on risky cards. The phone keeps a key that only
// a fingerprint unlocks (Android breaks it when a new fingerprint is added); Novi keeps its public half and
// checks that each approval was signed for that card, with a one-time challenge.
const keyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = (pub) => pub.export({ format: 'der', type: 'spki' }).toString('base64');
const sign = (priv, text) => crypto.sign('sha256', Buffer.from(text), priv).toString('base64');
const store = (now = () => 1000) => createFingerprints({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')), 'fingerprints.json'), now });

describe('fingerprint keys', () => {
  it('a phone registers its public key and stays registered after a restart', () => {
    const fp = store();
    const { publicKey } = keyPair();
    expect(fp.has('p1')).toBe(false);
    fp.register('p1', spki(publicKey));
    expect(fp.has('p1')).toBe(true);
    const again = createFingerprints({ file: fp.file });
    expect(again.has('p1')).toBe(true);
  });
  it('refuses something that is not an EC P-256 public key', () => {
    const fp = store();
    expect(() => fp.register('p1', 'bm90IGEga2V5')).toThrow();
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(() => fp.register('p1', spki(rsa))).toThrow();
  });
  it('an approval signed for that card with a fresh challenge passes, once', () => {
    const fp = store();
    const { publicKey, privateKey } = keyPair();
    fp.register('p1', spki(publicKey));
    const nonce = fp.challenge('p1', 'card-1');
    const sig = sign(privateKey, approveMessage('card-1', nonce));
    expect(fp.verify('p1', 'card-1', nonce, sig)).toBe(true);
    expect(fp.verify('p1', 'card-1', nonce, sig)).toBe(false); // used up
  });
  it('a signature for another card, another phone, an old challenge or a wrong key fails', () => {
    let t = 1000;
    const fp = store(() => t);
    const a = keyPair();
    const b = keyPair();
    fp.register('p1', spki(a.publicKey));
    fp.register('p2', spki(b.publicKey));
    const n1 = fp.challenge('p1', 'card-1');
    expect(fp.verify('p1', 'card-2', n1, sign(a.privateKey, approveMessage('card-2', n1)))).toBe(false);
    const n2 = fp.challenge('p1', 'card-1');
    expect(fp.verify('p2', 'card-1', n2, sign(b.privateKey, approveMessage('card-1', n2)))).toBe(false);
    const n3 = fp.challenge('p1', 'card-1');
    expect(fp.verify('p1', 'card-1', n3, sign(b.privateKey, approveMessage('card-1', n3)))).toBe(false);
    const n4 = fp.challenge('p1', 'card-1');
    t += 3 * 60_000;
    expect(fp.verify('p1', 'card-1', n4, sign(a.privateKey, approveMessage('card-1', n4)))).toBe(false);
  });
  it('the approval is tied to what the card said when it was signed', () => {
    const fp = store();
    const { publicKey, privateKey } = keyPair();
    fp.register('p1', spki(publicKey));
    const nonce = fp.challenge('p1', 'card-1', 'stamp-A');
    const sig = sign(privateKey, approveMessage('card-1', nonce));
    expect(fp.verify('p1', 'card-1', nonce, sig, 'stamp-B')).toBe(false); // the card changed after it was shown
    const n2 = fp.challenge('p1', 'card-1', 'stamp-A');
    expect(fp.verify('p1', 'card-1', n2, sign(privateKey, approveMessage('card-1', n2)), 'stamp-A')).toBe(true);
  });
  it('removing the key ends it', () => {
    const fp = store();
    fp.register('p1', spki(keyPair().publicKey));
    fp.remove('p1');
    expect(fp.has('p1')).toBe(false);
  });
});

describe('the trust rules take a fingerprint', () => {
  const phone = { deviceId: 'p1' };
  const trust = (has = true) => createRemoteTrust({
    pin: (p) => p.pin === '1234', hasPin: () => true,
    fingerprint: (proof, from, approval) => proof.fingerprint?.verified === true && proof.fingerprint.approvalId === approval.id && proof.fingerprint.deviceId === from.deviceId,
    hasFingerprint: () => has,
  });
  it('instead of the PIN on a high-risk card and on a PIN card from the phone', () => {
    const fpProof = (id) => ({ fingerprint: { verified: true, approvalId: id, deviceId: 'p1' } });
    expect(trust().check({ id: 'a', tier: 'high' }, phone, fpProof('a'))).toEqual({ ok: true });
    expect(trust().check({ id: 'b', pin: true }, phone, fpProof('b'))).toEqual({ ok: true });
  });
  it('instead of a passkey on deletes and payments', () => {
    expect(trust().check({ id: 'c', kind: 'delete' }, phone, { fingerprint: { verified: true, approvalId: 'c', deviceId: 'p1' } })).toEqual({ ok: true });
  });
  it('says fingerprint is the way when the phone has one set up, PIN otherwise', () => {
    expect(trust().check({ id: 'a', tier: 'high' }, phone, {})).toEqual({ ok: false, need: 'fingerprint' });
    expect(trust(false).check({ id: 'a', tier: 'high' }, phone, {})).toEqual({ ok: false, need: 'pin' });
  });
  // Security review 2026-11-11: with a key on the phone, the PIN alone from that phone is not enough (a thief who
  // overheard it could approve); the PIN stays for the laptop and for setting fingerprint up again.
  it('a phone with a fingerprint key can no longer approve with the PIN alone; without a key the PIN works', () => {
    expect(trust().check({ id: 'a', tier: 'high' }, phone, { pin: '1234' })).toEqual({ ok: false, need: 'fingerprint' });
    expect(trust(false).check({ id: 'a', tier: 'high' }, phone, { pin: '1234' })).toEqual({ ok: true });
    expect(trust().check({ id: 'a', pin: true }, 'local', { pin: '1234' })).toEqual({ ok: true });
  });
  it('a fingerprint for another card does not count', () => {
    expect(trust().check({ id: 'a', tier: 'high' }, phone, { fingerprint: { verified: true, approvalId: 'zzz', deviceId: 'p1' } }).ok).toBe(false);
  });
  it('the laptop itself never uses a fingerprint', () => {
    expect(trust().check({ id: 'a', pin: true }, 'local', { fingerprint: { verified: true, approvalId: 'a', deviceId: 'p1' } }).ok).toBe(false);
  });
});
