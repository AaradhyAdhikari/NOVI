import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from '../errors.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';

// Connected accounts (no secrets): data/accounts.json
export class AccountRegistry {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { accounts: d.accounts || [], defaults: d.defaults || {} };
    } catch {
      return { accounts: [], defaults: {} };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(provider) {
    return this.data.accounts.filter((a) => !provider || a.provider === provider);
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  defaultFor(provider) {
    return this.get(this.data.defaults[provider]);
  }

  _labelTaken(provider, label, exceptId) {
    return this.list(provider).some((a) => a.label === label && a.id !== exceptId);
  }

  add({ provider, email, scopes = [] }) {
    const e = norm(email);
    const existing = this.list(provider).find((a) => a.email === e);
    if (existing) {
      Object.assign(existing, { scopes, status: 'connected', connectedAt: new Date().toISOString() });
      this._save();
      return existing;
    }
    const base = slug(e.split('@')[0]);
    let label = base;
    for (let i = 2; this._labelTaken(provider, label); i++) label = `${base}-${i}`;
    const account = { id: crypto.randomUUID(), provider, email: e, label, scopes, connectedAt: new Date().toISOString(), status: 'connected' };
    this.data.accounts.push(account);
    this._save();
    return account;
  }

  remove(id) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    for (const [provider, def] of Object.entries(this.data.defaults)) if (def === id) this.data.defaults[provider] = null;
    this._save();
    return this.data.accounts.length !== before;
  }

  setLabel(id, label) {
    const account = this.get(id);
    if (!account) throw new UserFacingError('That account is not connected.');
    const l = slug(label);
    if (this._labelTaken(account.provider, l, id)) throw new UserFacingError(`Another account is already called "${l}".`);
    account.label = l;
    this._save();
    return account;
  }

  setDefault(provider, id) {
    if (id && this.get(id)?.provider !== provider) throw new UserFacingError('That account is not connected.');
    this.data.defaults[provider] = id || null;
    this._save();
  }

  markExpired(id) {
    const account = this.get(id);
    if (!account) return;
    account.status = 'expired';
    this._save();
  }
}
