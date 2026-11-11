// Fingerprint approvals (user, 2026-11-11: "replace the PIN with the user's fingerprint and face"). The phone
// app keeps a key in Android's keystore that only a fingerprint unlocks, made so Android breaks it when a new
// fingerprint is added to the phone (Android never says WHICH enrolled finger matched, so that is how "only
// mine" holds). Novi keeps the key's public half per phone and checks each approval: the phone signs
// "novi-approve:<card id>:<challenge>" for a challenge Novi gave out for that card, used once, 2 minutes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CHALLENGE_MS = 2 * 60_000;
export const approveMessage = (approvalId, nonce) => `novi-approve:${approvalId}:${nonce}`;

function publicKeyOf(spkiB64) {
  const key = crypto.createPublicKey({ key: Buffer.from(String(spkiB64 || ''), 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Not a fingerprint key Novi can use.');
  return key;
}

export function createFingerprints({ file, now = Date.now }) {
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')).keys || {}; } catch { /* none yet */ }
  const challenges = new Map(); // nonce → { deviceId, approvalId, at }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ keys }, null, 2));
  };
  return {
    file,
    has: (deviceId) => Boolean(keys[deviceId]),
    register(deviceId, spkiB64) {
      publicKeyOf(spkiB64); // throws on anything else
      keys[deviceId] = { publicKey: String(spkiB64), at: new Date(now()).toISOString() };
      save();
    },
    remove(deviceId) {
      delete keys[deviceId];
      save();
    },
    // stamp: what the card says right now (app.js cardStamp); the approval only counts for that same card.
    challenge(deviceId, approvalId, stamp = '') {
      for (const [n, c] of challenges) if (now() - c.at > CHALLENGE_MS) challenges.delete(n);
      const nonce = crypto.randomBytes(24).toString('base64url');
      challenges.set(nonce, { deviceId, approvalId, stamp: String(stamp), at: now() });
      return nonce;
    },
    verify(deviceId, approvalId, nonce, sigB64, stamp = '') {
      const c = challenges.get(String(nonce));
      if (!c) return false;
      challenges.delete(String(nonce)); // one try per challenge
      if (c.deviceId !== deviceId || c.approvalId !== approvalId || c.stamp !== String(stamp) || now() - c.at > CHALLENGE_MS || !keys[deviceId]) return false;
      try {
        return crypto.verify('sha256', Buffer.from(approveMessage(approvalId, nonce)), publicKeyOf(keys[deviceId].publicKey), Buffer.from(String(sigB64 || ''), 'base64'));
      } catch { return false; }
    },
  };
}
