import fs from 'node:fs';
import path from 'node:path';
import * as simpleWebAuthn from '@simplewebauthn/server';

// Fingerprint / face confirmation for deletes and payments from a phone (WebAuthn passkeys).
// The phone checks the finger or face itself and signs a one-time challenge; Novi only ever
// sees that signature. One challenge per approval, 2-minute expiry, single use.
// rpId must be a domain name (the Tailscale ts.net name) — WebAuthn doesn't work on bare IPs.

const CHALLENGE_MS = 2 * 60_000;
const toB64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

export class Passkeys {
  constructor({ file, rpId, origin, now = () => Date.now(), lib = simpleWebAuthn }) {
    this.file = file;
    this.rpId = rpId;
    this.origin = origin;
    this.now = now;
    this.lib = lib;
    this.pending = new Map(); // `${kind}:${deviceId}:${approvalId}` → { challenge, expires }
    try { this.devices = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.devices = {}; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.devices, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  _remember(key, challenge) {
    this.pending.set(key, { challenge, expires: this.now() + CHALLENGE_MS });
  }

  // Single use: the challenge is gone after the first look, valid or not.
  _take(key) {
    const entry = this.pending.get(key);
    this.pending.delete(key);
    return entry && this.now() <= entry.expires ? entry.challenge : null;
  }

  has(deviceId) {
    return Boolean(this.devices[deviceId]?.length);
  }

  async registrationOptions(deviceId) {
    const options = await this.lib.generateRegistrationOptions({
      rpName: 'Novi',
      rpID: this.rpId,
      userName: `novi-${deviceId.slice(0, 8)}`,
      userDisplayName: 'Novi phone',
      attestationType: 'none',
      excludeCredentials: (this.devices[deviceId] || []).map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    });
    this._remember(`reg:${deviceId}:`, options.challenge);
    return options;
  }

  async verifyRegistration(deviceId, response) {
    const expectedChallenge = this._take(`reg:${deviceId}:`);
    if (!expectedChallenge) return false;
    try {
      const { verified, registrationInfo } = await this.lib.verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin: this.origin, expectedRPID: this.rpId, requireUserVerification: true,
      });
      if (!verified) return false;
      const { id, publicKey, counter, transports } = registrationInfo.credential;
      this.devices[deviceId] = [...(this.devices[deviceId] || []).filter((c) => c.id !== id), { id, publicKey: toB64(publicKey), counter, transports }];
      this._save();
      return true;
    } catch {
      return false;
    }
  }

  async authOptions(deviceId, approvalId) {
    if (!this.has(deviceId)) throw new Error('No fingerprint / face set up on this phone.');
    const options = await this.lib.generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: 'required',
      allowCredentials: this.devices[deviceId].map((c) => ({ id: c.id, transports: c.transports })),
    });
    this._remember(`auth:${deviceId}:${approvalId}`, options.challenge);
    return options;
  }

  async verifyAuth(deviceId, approvalId, response) {
    const expectedChallenge = this._take(`auth:${deviceId}:${approvalId}`);
    const stored = (this.devices[deviceId] || []).find((c) => c.id === response?.id);
    if (!expectedChallenge || !stored) return false;
    try {
      const { verified, authenticationInfo } = await this.lib.verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: this.origin, expectedRPID: this.rpId, requireUserVerification: true,
        credential: { id: stored.id, publicKey: fromB64(stored.publicKey), counter: stored.counter, transports: stored.transports },
      });
      if (!verified) return false;
      stored.counter = authenticationInfo.newCounter;
      this._save();
      return true;
    } catch {
      return false;
    }
  }

  removeDevice(deviceId) {
    for (const key of this.pending.keys()) if (key.includes(`:${deviceId}:`)) this.pending.delete(key);
    if (!this.devices[deviceId]) return;
    delete this.devices[deviceId];
    this._save();
  }
}
