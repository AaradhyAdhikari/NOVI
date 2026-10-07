import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Voice PIN for high-risk approvals from a phone (spec: remote access, "Voice PIN").
// Set at the laptop only; stored as a scrypt hash, never in plain text, logs, transcript or memory.

const WORDS = {
  zero: '0', oh: '0', o: '0', shoonya: '0', shunya: '0',
  one: '1', won: '1', ek: '1',
  two: '2', to: '2', too: '2', do: '2',
  three: '3', teen: '3',
  four: '4', for: '4', char: '4', chaar: '4',
  five: '5', paanch: '5', panch: '5',
  six: '6', chhe: '6', che: '6', chhah: '6',
  seven: '7', saat: '7',
  eight: '8', ate: '8', aath: '8',
  nine: '9', nau: '9',
};

// "one two three four" / "1 2 3 4." / "ek do teen char" → "1234"; anything else → null.
export function parseSpokenPin(text) {
  const tokens = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let digits = '';
  for (const token of tokens) {
    if (/^\d+$/.test(token)) digits += token;
    else if (WORDS[token]) digits += WORDS[token];
    else return null;
  }
  return /^\d{4,8}$/.test(digits) ? digits : null;
}

const PIN_INPUTS = new Set(['voice', 'voice-or-typed']);
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32);

export class RemotePin extends EventEmitter {
  constructor({ file, now = () => Date.now(), maxFailures = 3, lockMs = 15 * 60_000 }) {
    super();
    this.file = file;
    this.now = now;
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.failures = 0;
    this.lockedUntil = 0;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  set(pin) {
    if (!/^\d{4,8}$/.test(String(pin))) throw new Error('The PIN must be 4 to 8 digits.');
    const salt = crypto.randomBytes(16);
    this.data = { ...this.data, salt: salt.toString('hex'), hash: hashPin(pin, salt).toString('hex'), setAt: new Date(this.now()).toISOString() };
    this.failures = 0;
    this.lockedUntil = 0;
    this._save();
  }

  isSet() {
    return Boolean(this.data.hash);
  }

  check(pin) {
    if (this.now() < this.lockedUntil) return { ok: false, locked: true, lockedUntil: this.lockedUntil };
    if (!this.isSet()) return { ok: false, locked: false };
    const ok = crypto.timingSafeEqual(hashPin(pin, Buffer.from(this.data.salt, 'hex')), Buffer.from(this.data.hash, 'hex'));
    if (ok) {
      this.failures = 0;
      return { ok: true, locked: false };
    }
    this.failures += 1;
    if (this.failures >= this.maxFailures) {
      this.failures = 0;
      this.lockedUntil = this.now() + this.lockMs;
      this.emit('locked', { lockedUntil: this.lockedUntil });
      return { ok: false, locked: true, lockedUntil: this.lockedUntil };
    }
    return { ok: false, locked: false };
  }

  getSettings() {
    return { pinInput: this.data.pinInput || 'voice' };
  }

  setSettings({ pinInput }) {
    if (!PIN_INPUTS.has(pinInput)) throw new Error('PIN input must be "voice" or "voice-or-typed".');
    this.data = { ...this.data, pinInput };
    this._save();
  }
}
