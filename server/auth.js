import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function isLocalAddress(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export class Pairing {
  constructor({ file, now = () => Date.now(), codeTtlMs = 5 * 60_000, maxFailures = 5, lockMs = 60_000 }) {
    this.file = file;
    this.now = now;
    this.codeTtlMs = codeTtlMs;
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.failures = 0;
    this.lockedUntil = 0;
    this.devices = this._load();
    this._rotate();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _rotate() {
    this.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.codeExpires = this.now() + this.codeTtlMs;
  }

  currentCode() {
    if (this.now() >= this.codeExpires) this._rotate();
    return { code: this.code, expiresAt: this.codeExpires };
  }

  pair(code, name = 'Device') {
    if (this.now() < this.lockedUntil) return { ok: false, error: 'Too many attempts. Wait a minute.' };
    if (String(code ?? '').trim() !== this.currentCode().code) {
      this.failures += 1;
      if (this.failures >= this.maxFailures) {
        this.failures = 0;
        this.lockedUntil = this.now() + this.lockMs;
        this._rotate();
      }
      return { ok: false, error: 'Wrong code.' };
    }
    this.failures = 0;
    this._rotate(); // codes are single use
    return { ok: true, ...this.issue(name, 'qr') };
  }

  // A new paired device without a code: a phone on the owner's Tailscale account, or one the
  // laptop allowed ("Ask the laptop"). via: 'qr' | 'tailscale' | 'laptop'.
  issue(name = 'Device', via = 'qr') {
    const token = crypto.randomBytes(32).toString('hex');
    const device = { id: crypto.randomUUID(), name: String(name).slice(0, 60), via, tokenHash: hash(token), pairedAt: new Date(this.now()).toISOString() };
    this.devices.push(device);
    this._save();
    return { token, deviceId: device.id };
  }

  verify(token) {
    if (!token) return null;
    const h = hash(token);
    return this.devices.find((d) => d.tokenHash === h) || null;
  }

  listDevices() {
    return this.devices.map(({ tokenHash, ...device }) => device);
  }

  revoke(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this._save();
    return true;
  }
}
