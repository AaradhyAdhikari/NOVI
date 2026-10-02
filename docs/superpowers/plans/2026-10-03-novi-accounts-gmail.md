# Novi Accounts + Gmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Multi-account Gmail for Novi — connect via Google consent (no passwords), search/read freely, send only after an on-screen approval that shows the sending account and full email; tokens encrypted with DPAPI; mail content only ever processed by Groq.

**Architecture:** `accounts/` (registry, DPAPI secret store, account resolution) + `google/` (OAuth loopback+PKCE, Gmail REST client) + `tools/accountTools.js` registered on the existing ToolRegistry. The Agent gains `precheck`/`detail` support (ask-which-account before approval; full email in the approval card) and privacy routing (sensitive tool results never reach a non-private provider).

**Tech Stack:** Node 24 `fetch`/`http`/`crypto`, PowerShell DPAPI (`System.Security.Cryptography.ProtectedData`), Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-novi-accounts-gmail-design.md`

## Global Constraints

- No passwords handled anywhere. Scopes exactly: `gmail.readonly`, `gmail.send`, `openid`, `email`.
- Secrets reach PowerShell only as base64 on **stdin** (verified 2026-10-03: plain UTF-8 on stdin gets mangled; base64 round-trips).
- `gmail_search`, `gmail_read`, `accounts_*`, `gmail_connect` are tier `low`; `gmail_send` is `medium` with approval title `Send from <label> (<email>) to <to>: <subject>` and detail = full body.
- Results of `gmail_search` / `gmail_read` carry `sensitive: true`; a turn on a provider not in `NOVI_PRIVATE_PROVIDERS` (default `groq`) ends with "I can't read your mail right now — my private AI provider is busy. Try again in a minute." without sending content onward.
- Tests never call Google or PowerShell except one Windows-only real-DPAPI round-trip test.
- No Claude usage; brain stays on Groq/Gemini router.

## Review Focus

1. Header injection in outgoing mail (`to`/`subject` containing CR/LF) — pinned in Task 4 (`buildMime` test).
2. Approval card must show the account actually used — describe() and run() resolve the same way; pinned in Task 5.
3. OAuth `state` mismatch / cancelled consent must not add an account — pinned in Task 3.
4. A failed secret write must not leave a half-connected account — pinned in Task 3.
5. Email content must not reach Gemini via a turn that started on Gemini — pinned in Task 5 (agent privacy test).

---

### Task 1: Config + secret store

**Files:** Modify `server/config.js`, `tests/server/config.test.js`, `.env.example`. Create `server/accounts/secrets.js`, `tests/server/secrets.test.js`.

**Produces:** config `{ googleClientId, googleClientSecret, privateProviders: string[] }`; `dpapiCipher(run?)`, `fileKeyCipher(keyFile)`, `defaultCipher(dataDir)`, `runPowerShell(script, input)`, `class SecretStore({file, cipher})` with `set(id, plain)`, `get(id) → string|null`, `delete(id)`.

- [ ] Add to `tests/server/config.test.js` (inside `describe('loadConfig')`):

```js
  it('reads Google OAuth credentials and private providers', () => {
    const c = loadConfig({ ...base, GOOGLE_CLIENT_ID: ' id.apps.googleusercontent.com ', GOOGLE_CLIENT_SECRET: 'GOCSPX-x' });
    expect(c.googleClientId).toBe('id.apps.googleusercontent.com');
    expect(c.googleClientSecret).toBe('GOCSPX-x');
    expect(c.privateProviders).toEqual(['groq']);
    expect(loadConfig({ ...base, NOVI_PRIVATE_PROVIDERS: 'groq,cerebras' }).privateProviders).toEqual(['groq', 'cerebras']);
    expect(loadConfig(base).googleClientId).toBe('');
  });
```

- [ ] Write `tests/server/secrets.test.js`:

```js
// tests/server/secrets.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore, dpapiCipher, fileKeyCipher } from '../../server/accounts/secrets.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-sec-'));

describe('dpapiCipher', () => {
  it('passes secrets to PowerShell as base64 on stdin, never in the script', async () => {
    const calls = [];
    const run = async (script, input) => {
      calls.push({ script, input });
      return script.includes('::Protect(') ? `BLOB(${input})` : input.replace(/^BLOB\(|\)$/g, '');
    };
    const c = dpapiCipher(run);
    const blob = await c.protect('refresh-ドキュメント');
    expect(calls[0].input).toBe(Buffer.from('refresh-ドキュメント').toString('base64'));
    expect(calls[0].script).not.toContain('refresh');
    expect(await c.unprotect(blob)).toBe('refresh-ドキュメント');
  });

  it.runIf(process.platform === 'win32')('round-trips with real Windows DPAPI', async () => {
    const c = dpapiCipher();
    expect(await c.unprotect(await c.protect('real-secret-✓'))).toBe('real-secret-✓');
  }, 30000);
});

describe('SecretStore with fileKeyCipher', () => {
  it('stores encrypted values, reads them back across instances, deletes them', async () => {
    const dir = tmp();
    const make = () => new SecretStore({ file: path.join(dir, 'secrets.json'), cipher: fileKeyCipher(path.join(dir, 'secret.key')) });
    const store = make();
    await store.set('acc1', 'my-refresh-token');
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain('my-refresh-token');
    expect(await store.get('acc1')).toBe('my-refresh-token');
    expect(await make().get('acc1')).toBe('my-refresh-token');
    store.delete('acc1');
    expect(await store.get('acc1')).toBeNull();
    expect(await store.get('missing')).toBeNull();
  });
});
```

- [ ] Run both — expect FAIL (missing module / undefined config fields).

- [ ] Implement `server/accounts/secrets.js`:

```js
// server/accounts/secrets.js
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PS = (fn) => `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
const PS_PROTECT = PS('Protect');
const PS_UNPROTECT = PS('Unprotect');

export function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      resolve(String(stdout).trim());
    });
    child.stdin.end(input);
  });
}

// Windows DPAPI (current user). Secrets travel to PowerShell as base64 on stdin, never in argv.
export function dpapiCipher(run = runPowerShell) {
  return {
    protect: async (plain) => run(PS_PROTECT, Buffer.from(String(plain), 'utf8').toString('base64')),
    unprotect: async (blob) => Buffer.from(await run(PS_UNPROTECT, blob), 'base64').toString('utf8'),
  };
}

// Non-Windows fallback: AES-256-GCM with a key file next to Novi's data.
export function fileKeyCipher(keyFile) {
  const key = () => {
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(keyFile);
  };
  return {
    protect: async (plain) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    unprotect: async (blob) => {
      const b = Buffer.from(blob, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

export function defaultCipher(dataDir) {
  return process.platform === 'win32' ? dpapiCipher() : fileKeyCipher(path.join(dataDir, 'secret.key'));
}

export class SecretStore {
  constructor({ file, cipher }) {
    this.file = file;
    this.cipher = cipher;
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  _save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async set(id, plain) {
    const blob = await this.cipher.protect(plain);
    const data = this._load();
    data[id] = blob;
    this._save(data);
  }

  async get(id) {
    const blob = this._load()[id];
    return blob ? this.cipher.unprotect(blob) : null;
  }

  delete(id) {
    const data = this._load();
    if (!(id in data)) return;
    delete data[id];
    this._save(data);
  }
}
```

- [ ] In `server/config.js` `loadConfig` return object, after `coder`, add:

```js
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    googleClientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
    privateProviders: splitList(env.NOVI_PRIVATE_PROVIDERS || 'groq'),
```

- [ ] Append to `.env.example`:

```
# Gmail (Google Cloud "Desktop app" OAuth client; publishing status "In production")
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# Providers allowed to see email content (default groq)
# NOVI_PRIVATE_PROVIDERS=groq
```

- [ ] Run config + secrets tests — PASS. Commit `feat: DPAPI secret store and Google config`.

---

### Task 2: Account registry + resolution

**Files:** Create `server/accounts/registry.js`, `server/accounts/resolve.js`, `tests/server/accounts.test.js`.

**Produces:** `class AccountRegistry(file)` — `list(provider?)`, `get(id)`, `defaultFor(provider)`, `add({provider,email,scopes})`, `remove(id) → boolean`, `setLabel(id,label)`, `setDefault(provider,id|null)`, `markExpired(id)`. Account: `{ id, provider, email, label, scopes, connectedAt, status }`. `resolveAccount(registry, provider, requested, {allowAll}) → {account}|{accounts}|{ask:[{label,email}]}|{error}`; `askNote(ask) → string`.

- [ ] Write `tests/server/accounts.test.js`:

```js
// tests/server/accounts.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountRegistry } from '../../server/accounts/registry.js';
import { resolveAccount, askNote } from '../../server/accounts/resolve.js';
import { UserFacingError } from '../../server/errors.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-acc-')), 'accounts.json');

function two() {
  const r = new AccountRegistry(file());
  const p = r.add({ provider: 'google', email: 'p@gmail.com' });
  r.setLabel(p.id, 'Personal');
  const c = r.add({ provider: 'google', email: 'c@college.edu' });
  r.setLabel(c.id, 'college');
  return { r, p, c };
}

describe('AccountRegistry', () => {
  it('labels new accounts from the email, unique per provider', () => {
    const r = new AccountRegistry(file());
    const a = r.add({ provider: 'google', email: 'Aaradhy.A@gmail.com', scopes: ['s'] });
    expect(a).toMatchObject({ provider: 'google', email: 'aaradhy.a@gmail.com', label: 'aaradhy-a', status: 'connected', scopes: ['s'] });
    expect(r.add({ provider: 'google', email: 'aaradhy.a@college.edu' }).label).toBe('aaradhy-a-2');
  });

  it('reconnecting the same email updates the existing account', () => {
    const r = new AccountRegistry(file());
    const a = r.add({ provider: 'google', email: 'x@gmail.com' });
    r.markExpired(a.id);
    expect(r.get(a.id).status).toBe('expired');
    const again = r.add({ provider: 'google', email: 'X@gmail.com', scopes: ['new'] });
    expect(again.id).toBe(a.id);
    expect(again).toMatchObject({ status: 'connected', scopes: ['new'] });
    expect(r.list('google')).toHaveLength(1);
  });

  it('renames, rejecting duplicate labels', () => {
    const { r, c } = two();
    expect(r.get(c.id).label).toBe('college');
    expect(() => r.setLabel(c.id, 'PERSONAL')).toThrow(UserFacingError);
  });

  it('sets, clears and persists defaults; removing the default clears it', () => {
    const f = file();
    const r = new AccountRegistry(f);
    const a = r.add({ provider: 'google', email: 'a@gmail.com' });
    r.setDefault('google', a.id);
    expect(new AccountRegistry(f).defaultFor('google').email).toBe('a@gmail.com');
    r.setDefault('google', null);
    expect(r.defaultFor('google')).toBeNull();
    r.setDefault('google', a.id);
    expect(r.remove(a.id)).toBe(true);
    expect(r.defaultFor('google')).toBeNull();
    expect(new AccountRegistry(f).list()).toEqual([]);
  });
});

describe('resolveAccount', () => {
  it('explains when nothing is connected', () => {
    expect(resolveAccount(new AccountRegistry(file()), 'google').error).toMatch(/No Gmail account is connected/);
  });

  it('uses the only account without asking', () => {
    const r = new AccountRegistry(file());
    r.add({ provider: 'google', email: 'solo@gmail.com' });
    expect(resolveAccount(r, 'google').account.email).toBe('solo@gmail.com');
  });

  it('matches label, email, or a unique prefix', () => {
    const { r } = two();
    expect(resolveAccount(r, 'google', 'College').account.email).toBe('c@college.edu');
    expect(resolveAccount(r, 'google', 'p@gmail.com').account.label).toBe('personal');
    expect(resolveAccount(r, 'google', 'coll').account.label).toBe('college');
  });

  it('lists connected accounts for unknown names', () => {
    const { r } = two();
    expect(resolveAccount(r, 'google', 'work').error).toBe('No Gmail account called "work". Connected: personal, college.');
  });

  it('asks when several are connected and there is no default, otherwise uses the default', () => {
    const { r, c } = two();
    const res = resolveAccount(r, 'google');
    expect(res.ask).toEqual([{ label: 'personal', email: 'p@gmail.com' }, { label: 'college', email: 'c@college.edu' }]);
    expect(askNote(res.ask)).toBe('Which account: personal (p@gmail.com) or college (c@college.edu)?');
    r.setDefault('google', c.id);
    expect(resolveAccount(r, 'google').account.label).toBe('college');
  });

  it('accepts "all" only where allowed', () => {
    const { r } = two();
    expect(resolveAccount(r, 'google', 'all', { allowAll: true }).accounts).toHaveLength(2);
    expect(resolveAccount(r, 'google', 'all').error).toMatch(/which Gmail account/);
  });
});
```

- [ ] Run — FAIL. Implement:

```js
// server/accounts/registry.js
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
```

```js
// server/accounts/resolve.js
const NAMES = { google: 'Gmail' };

// Which account a request means: named → that one; else the only one; else the default; else ask.
export function resolveAccount(registry, provider, requested, { allowAll = false } = {}) {
  const name = NAMES[provider] || provider;
  const accounts = registry.list(provider);
  if (!accounts.length) return { error: `No ${name} account is connected yet — say "connect my ${name}".` };
  const q = requested == null ? '' : String(requested).trim().toLowerCase();
  if (q) {
    if (q === 'all') return allowAll ? { accounts } : { error: `Tell me which ${name} account to use.` };
    const exact = accounts.find((a) => a.label === q || a.email === q);
    if (exact) return { account: exact };
    const partial = accounts.filter((a) => a.label.startsWith(q) || a.email.startsWith(q));
    if (partial.length === 1) return { account: partial[0] };
    return { error: `No ${name} account called "${requested}". Connected: ${accounts.map((a) => a.label).join(', ')}.` };
  }
  if (accounts.length === 1) return { account: accounts[0] };
  const def = registry.defaultFor(provider);
  if (def) return { account: def };
  return { ask: accounts.map(({ label, email }) => ({ label, email })) };
}

export function askNote(ask) {
  return `Which account: ${ask.map((a) => `${a.label} (${a.email})`).join(' or ')}?`;
}
```

- [ ] Run — PASS. Commit `feat: multi-account registry and account resolution`.

---

### Task 3: Google OAuth (loopback + PKCE)

**Files:** Create `server/google/oauth.js`, `tests/server/oauth.test.js`.

**Consumes:** `AccountRegistry` (Task 2), `SecretStore`-like `{set,get,delete}` (Task 1), `openUrl` (`server/laptop/opener.js`).
**Produces:** `GMAIL_SCOPES`, `pkcePair()`, `buildAuthUrl({clientId, redirectUri, state, challenge, scopes?})`, `emailFromIdToken(jwt)`, `startLoopback({timeoutMs}) → {redirectUri, result: Promise<params>, close()}`, `class GoogleAuth({clientId, clientSecret, accounts, secrets, openUrl?, fetchImpl?, now?, startLoopback?, timeoutMs?})` with `configured`, `connect() → {url, done: Promise<account>}`, `accessToken(account) → Promise<string>`, `invalidate(accountId)`, `disconnect(accountId)`.

- [ ] Write `tests/server/oauth.test.js`:

```js
// tests/server/oauth.test.js
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth, buildAuthUrl, startLoopback, GMAIL_SCOPES, emailFromIdToken } from '../../server/google/oauth.js';
import { AccountRegistry } from '../../server/accounts/registry.js';
import { UserFacingError } from '../../server/errors.js';

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
const granted = { access_token: 'at1', expires_in: 3600, refresh_token: 'rt1', scope: GMAIL_SCOPES.join(' '), id_token: jwt({ email: 'Me@Gmail.com' }) };

function memorySecrets({ failSet = false } = {}) {
  const map = new Map();
  return { map, set: async (id, v) => { if (failSet) throw new Error('DPAPI unavailable'); map.set(id, v); }, get: async (id) => map.get(id) ?? null, delete: (id) => map.delete(id) };
}

function setup({ responses = [], configured = true, secrets = memorySecrets() } = {}) {
  const accounts = new AccountRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-oauth-')), 'accounts.json'));
  const opened = [];
  const requests = [];
  let finish;
  const loopResult = new Promise((resolve) => { finish = resolve; });
  let t = 1_000_000;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), body: String(init.body || '') });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status || 200 });
  };
  const auth = new GoogleAuth({
    clientId: configured ? 'cid' : '',
    clientSecret: configured ? 'secret' : '',
    accounts,
    secrets,
    openUrl: async (u) => { opened.push(u); },
    fetchImpl,
    now: () => t,
    startLoopback: async () => ({ redirectUri: 'http://127.0.0.1:5555/callback', result: loopResult, close() {} }),
  });
  return { auth, accounts, secrets, opened, requests, finish, advance: (ms) => { t += ms; } };
}

async function connected(opts) {
  const s = setup({ responses: [{ body: granted }], ...opts });
  const { done } = await s.auth.connect();
  s.finish({ code: 'c1', state: new URL(s.opened[0]).searchParams.get('state') });
  const account = await done;
  return { ...s, account };
}

describe('buildAuthUrl', () => {
  it('asks Google for offline Gmail access with PKCE', () => {
    const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1/callback', state: 'st', challenge: 'ch' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'cid', redirect_uri: 'http://127.0.0.1:1/callback', response_type: 'code', scope: GMAIL_SCOPES.join(' '),
      code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', access_type: 'offline', prompt: 'consent',
    });
  });

  it('reads the email from an ID token', () => {
    expect(emailFromIdToken(jwt({ email: 'A@B.com' }))).toBe('a@b.com');
    expect(emailFromIdToken('garbage')).toBeNull();
  });
});

describe('GoogleAuth.connect', () => {
  it('refuses when Google credentials are missing', async () => {
    await expect(setup({ configured: false }).auth.connect()).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('opens consent, exchanges the code with the PKCE verifier, stores the refresh token, registers the account', async () => {
    const { account, opened, requests, secrets, accounts } = await connected();
    expect(account).toMatchObject({ email: 'me@gmail.com', label: 'me', provider: 'google' });
    expect(secrets.map.get(account.id)).toBe('rt1');
    expect(accounts.list('google')).toHaveLength(1);
    const body = new URLSearchParams(requests[0].body);
    expect(requests[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('code')).toBe('c1');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:5555/callback');
    expect(body.get('client_secret')).toBe('secret');
    const challenge = crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url');
    expect(new URL(opened[0]).searchParams.get('code_challenge')).toBe(challenge);
  });

  it('rejects a callback with the wrong state and adds nothing', async () => {
    const s = setup({ responses: [{ body: granted }] });
    const { done } = await s.auth.connect();
    s.finish({ code: 'c1', state: 'forged' });
    await expect(done).rejects.toThrow(/security check/);
    expect(s.accounts.list()).toEqual([]);
    expect(s.requests).toEqual([]);
  });

  it('reports a cancelled consent', async () => {
    const s = setup();
    const { done } = await s.auth.connect();
    s.finish({ error: 'access_denied', state: new URL(s.opened[0]).searchParams.get('state') });
    await expect(done).rejects.toThrow(/cancelled/);
  });

  it('requires the Gmail permission to be granted', async () => {
    const s = setup({ responses: [{ body: { ...granted, scope: 'openid email' } }] });
    const { done } = await s.auth.connect();
    s.finish({ code: 'c1', state: new URL(s.opened[0]).searchParams.get('state') });
    await expect(done).rejects.toThrow(/Gmail/);
    expect(s.accounts.list()).toEqual([]);
  });

  it('leaves no half-connected account when the token cannot be stored', async () => {
    const s = setup({ responses: [{ body: granted }], secrets: memorySecrets({ failSet: true }) });
    const { done } = await s.auth.connect();
    s.finish({ code: 'c1', state: new URL(s.opened[0]).searchParams.get('state') });
    await expect(done).rejects.toThrow(/securely/);
    expect(s.accounts.list()).toEqual([]);
  });
});

describe('GoogleAuth tokens', () => {
  it('reuses the access token until a minute before expiry, then refreshes', async () => {
    const s = await connected();
    expect(await s.auth.accessToken(s.account)).toBe('at1');
    expect(s.requests).toHaveLength(1);
    s.advance(3600_000 - 59_000);
    s.requests.length = 0;
    const next = { access_token: 'at2', expires_in: 3600 };
    s.auth.fetchImpl = async (url, init) => { s.requests.push({ url, body: String(init.body) }); return new Response(JSON.stringify(next)); };
    expect(await s.auth.accessToken(s.account)).toBe('at2');
    expect(new URLSearchParams(s.requests[0].body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(s.requests[0].body).get('refresh_token')).toBe('rt1');
  });

  it('marks the account expired and forgets the token on invalid_grant', async () => {
    const s = await connected();
    s.auth.invalidate(s.account.id);
    s.auth.fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await expect(s.auth.accessToken(s.account)).rejects.toThrow(UserFacingError);
    await expect(s.auth.accessToken(s.account)).rejects.toThrow(/reconnect/);
    expect(s.accounts.get(s.account.id).status).toBe('expired');
    expect(s.secrets.map.has(s.account.id)).toBe(false);
  });

  it('disconnect revokes at Google and removes the account even if revoking fails', async () => {
    const s = await connected();
    const seen = [];
    s.auth.fetchImpl = async (url, init) => { seen.push([String(url), String(init.body)]); throw new Error('offline'); };
    await s.auth.disconnect(s.account.id);
    expect(seen).toEqual([['https://oauth2.googleapis.com/revoke', 'token=rt1']]);
    expect(s.accounts.list()).toEqual([]);
    expect(s.secrets.map.size).toBe(0);
  });
});

describe('startLoopback', () => {
  it('captures the callback and shows a confirmation page', async () => {
    const loop = await startLoopback({ timeoutMs: 5000 });
    expect(loop.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const res = await fetch(`${loop.redirectUri}?code=x&state=y`);
    expect(await res.text()).toMatch(/connected/i);
    expect(await loop.result).toMatchObject({ code: 'x', state: 'y' });
  });

  it('times out', async () => {
    const loop = await startLoopback({ timeoutMs: 50 });
    await expect(loop.result).rejects.toThrow(/timed out/);
  });
});
```

- [ ] Run — FAIL. Implement:

```js
// server/google/oauth.js
import crypto from 'node:crypto';
import http from 'node:http';
import { UserFacingError } from '../errors.js';
import { openUrl as defaultOpenUrl } from '../laptop/opener.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge, scopes = GMAIL_SCOPES }) {
  const url = new URL(AUTH_URL);
  const params = {
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email ? String(payload.email).toLowerCase() : null;
  } catch {
    return null;
  }
}

const page = (ok) => `<!doctype html><meta charset="utf-8"><title>Novi</title>
<body style="font-family:system-ui,sans-serif;background:#0a0d14;color:#e8ecf4;display:grid;place-items:center;height:100vh;margin:0">
<h2>${ok ? 'Novi is connected to Gmail. You can close this tab.' : 'Gmail connection was cancelled. You can close this tab.'}</h2>`;

// One-shot local callback server for Google's installed-app (loopback) flow.
export function startLoopback({ timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settle;
    const result = new Promise((res, rej) => { settle = { res, rej }; });
    result.catch(() => {});
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(!params.error));
      clearTimeout(timer);
      server.close();
      settle.res(params);
    });
    const timer = setTimeout(() => {
      server.close();
      settle.rej(new UserFacingError('The Gmail connection timed out. Say "connect my Gmail" to try again.'));
    }, timeoutMs);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      redirectUri: `http://127.0.0.1:${server.address().port}/callback`,
      result,
      close: () => { clearTimeout(timer); server.close(); },
    }));
  });
}

class InvalidGrantError extends Error {}

export class GoogleAuth {
  constructor({ clientId, clientSecret, accounts, secrets, openUrl = defaultOpenUrl, fetchImpl = fetch, now = () => Date.now(), startLoopback: loopback = startLoopback, timeoutMs = 5 * 60_000 }) {
    Object.assign(this, { clientId, clientSecret, accounts, secrets, openUrl, fetchImpl, now, loopback, timeoutMs });
    this.cache = new Map();
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async connect() {
    if (!this.configured) throw new UserFacingError("Gmail isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to Novi's .env and restart it.");
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(16).toString('hex');
    const loop = await this.loopback({ timeoutMs: this.timeoutMs });
    const url = buildAuthUrl({ clientId: this.clientId, redirectUri: loop.redirectUri, state, challenge });
    await this.openUrl(url);
    const done = (async () => {
      const params = await loop.result;
      if (params.state !== state) throw new UserFacingError('The Gmail connection failed a security check. Please try again.');
      if (params.error || !params.code) throw new UserFacingError('The Gmail connection was cancelled.');
      const tokens = await this._token({ grant_type: 'authorization_code', code: params.code, redirect_uri: loop.redirectUri, code_verifier: verifier });
      const scopes = String(tokens.scope || '').split(' ').filter(Boolean);
      if (!scopes.includes(GMAIL_SCOPES[0])) throw new UserFacingError('Gmail access was not granted. Connect again and tick the Gmail permissions on Google\'s screen.');
      if (!tokens.refresh_token) throw new UserFacingError("Google didn't grant lasting access. Please connect again.");
      const email = emailFromIdToken(tokens.id_token);
      if (!email) throw new UserFacingError("Google didn't say which account this is. Please connect again.");
      const account = this.accounts.add({ provider: 'google', email, scopes });
      try {
        await this.secrets.set(account.id, tokens.refresh_token);
      } catch (err) {
        this.accounts.remove(account.id);
        throw new UserFacingError(`I couldn't store the Gmail key securely: ${err.message}`);
      }
      this.cache.set(account.id, { token: tokens.access_token, expiresAt: this.now() + (tokens.expires_in || 3600) * 1000 });
      return account;
    })();
    done.catch(() => {});
    return { url, done };
  }

  async _token(params) {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (json.error === 'invalid_grant') throw new InvalidGrantError(json.error_description || 'invalid_grant');
      throw new UserFacingError(`Google sign-in failed (${json.error || res.status}).`);
    }
    return json;
  }

  _expired(account) {
    this.accounts.markExpired(account.id);
    this.secrets.delete(account.id);
    this.cache.delete(account.id);
    return new UserFacingError(`Your ${account.label} Gmail connection expired — reconnect it in Settings.`);
  }

  async accessToken(account) {
    const cached = this.cache.get(account.id);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const refresh = await this.secrets.get(account.id);
    if (!refresh) throw this._expired(account);
    try {
      const t = await this._token({ grant_type: 'refresh_token', refresh_token: refresh });
      this.cache.set(account.id, { token: t.access_token, expiresAt: this.now() + (t.expires_in || 3600) * 1000 });
      return t.access_token;
    } catch (err) {
      if (err instanceof InvalidGrantError) throw this._expired(account);
      throw err;
    }
  }

  invalidate(accountId) {
    this.cache.delete(accountId);
  }

  async disconnect(accountId) {
    const refresh = await this.secrets.get(accountId).catch(() => null);
    if (refresh) {
      try {
        await this.fetchImpl(REVOKE_URL, { method: 'POST', headers: FORM, body: new URLSearchParams({ token: refresh }).toString(), signal: AbortSignal.timeout(10_000) });
      } catch { /* local removal still happens */ }
    }
    this.secrets.delete(accountId);
    this.cache.delete(accountId);
    this.accounts.remove(accountId);
  }
}
```

- [ ] Run — PASS. Commit `feat: Google OAuth loopback + PKCE with secure token storage`.

---

### Task 4: Gmail client

**Files:** Create `server/google/gmail.js`, `tests/server/gmail.test.js`.

**Produces:** `class GmailClient({ getToken(account), invalidate(account), fetchImpl? })` — `search(account, {query?, max?}) → [{id, threadId, from, subject, date, snippet, unread}]`, `read(account, id) → {…summary, to, cc, body}`, `send(account, {to, cc?, subject, body, replyTo?}) → {id, threadId}`; helpers `htmlToText`, `extractBody(payload)`, `encodeHeader(s)`, `buildMime({...}) → base64url`.

- [ ] Write `tests/server/gmail.test.js`:

```js
// tests/server/gmail.test.js
import { describe, it, expect } from 'vitest';
import { GmailClient, extractBody, buildMime, encodeHeader, htmlToText } from '../../server/google/gmail.js';
import { UserFacingError } from '../../server/errors.js';

const b64 = (s) => Buffer.from(s).toString('base64url');
const headers = (h) => Object.entries(h).map(([name, value]) => ({ name, value }));
const meta = (id, from, subject, { unread = true, extra = {} } = {}) => ({
  id, threadId: `t${id}`, snippet: `snip &amp; ${id}`, labelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'],
  payload: { headers: headers({ From: from, Subject: subject, Date: 'Thu, 2 Oct 2026 10:00:00 +0530', ...extra }) },
});
const acct = { id: 'a1', email: 'me@gmail.com', label: 'personal' };

function client(routes) {
  const calls = [];
  let invalidated = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => String(url).includes(r.match) && (r.method || 'GET') === (init.method || 'GET'));
    if (!route) throw new Error(`no route for ${url}`);
    const out = typeof route.reply === 'function' ? route.reply(calls) : route.reply;
    return new Response(JSON.stringify(out.body ?? out), { status: out.status || 200 });
  };
  const gmail = new GmailClient({ getToken: async () => 'tok', invalidate: () => { invalidated += 1; }, fetchImpl });
  return { gmail, calls, invalidated: () => invalidated };
}

describe('GmailClient.search', () => {
  it('lists messages with sender, subject, date, snippet and unread flag', async () => {
    const { gmail, calls } = client([
      { match: '/messages?q=', reply: { messages: [{ id: 'm1' }, { id: 'm2' }] } },
      { match: '/messages/m1?format=metadata', reply: meta('m1', 'Sir <sir@college.edu>', 'Class moved') },
      { match: '/messages/m2?format=metadata', reply: meta('m2', 'Amazon <a@amazon.in>', 'Order shipped', { unread: false }) },
    ]);
    const out = await gmail.search(acct, {});
    expect(calls[0].url).toContain(`q=${encodeURIComponent('in:inbox newer_than:7d')}`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(out).toEqual([
      { id: 'm1', threadId: 'tm1', from: 'Sir <sir@college.edu>', subject: 'Class moved', date: 'Thu, 2 Oct 2026 10:00:00 +0530', snippet: 'snip & m1', unread: true },
      { id: 'm2', threadId: 'tm2', from: 'Amazon <a@amazon.in>', subject: 'Order shipped', date: 'Thu, 2 Oct 2026 10:00:00 +0530', snippet: 'snip & m2', unread: false },
    ]);
  });

  it('returns nothing for an empty result', async () => {
    const { gmail } = client([{ match: '/messages?q=', reply: { resultSizeEstimate: 0 } }]);
    expect(await gmail.search(acct, { query: 'from:nobody' })).toEqual([]);
  });

  it('refreshes the token once on 401, then retries', async () => {
    const { gmail, invalidated } = client([
      { match: '/messages?q=', reply: (calls) => (calls.length === 1 ? { status: 401, body: {} } : { messages: [] }) },
    ]);
    expect(await gmail.search(acct, {})).toEqual([]);
    expect(invalidated()).toBe(1);
  });

  it('turns 403 into a spoken error', async () => {
    const { gmail } = client([{ match: '/messages?q=', reply: { status: 403, body: {} } }]);
    await expect(gmail.search(acct, {})).rejects.toThrow(UserFacingError);
    await expect(gmail.search(acct, {})).rejects.toThrow(/refused/);
  });
});

describe('GmailClient.read', () => {
  it('returns the plain-text part of a multipart email', async () => {
    const { gmail } = client([{
      match: '/messages/m1?format=full',
      reply: {
        id: 'm1', threadId: 'tm1', snippet: 'Hello', labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: headers({ From: 'Sir <sir@c.edu>', To: 'me@gmail.com', Subject: 'Class moved', Date: 'd' }),
          parts: [
            { mimeType: 'text/plain', filename: '', body: { data: b64('Hello ✓\r\nSee you') } },
            { mimeType: 'text/html', filename: '', body: { data: b64('<p>Hello</p>') } },
          ],
        },
      },
    }]);
    const m = await gmail.read(acct, 'm1');
    expect(m).toMatchObject({ id: 'm1', from: 'Sir <sir@c.edu>', to: 'me@gmail.com', subject: 'Class moved', body: 'Hello ✓\nSee you' });
  });
});

describe('body helpers', () => {
  it('converts HTML-only mail to text', () => {
    expect(htmlToText('<style>x{}</style><p>Hi&nbsp;there &amp; you</p>Bye')).toBe('Hi there & you\nBye');
    expect(extractBody({ mimeType: 'text/html', body: { data: b64('<div>A</div><div>B</div>') } })).toBe('A\nB');
  });

  it('skips attachments and caps very long bodies', () => {
    const payload = { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'x' } },
      { mimeType: 'text/plain', filename: '', body: { data: b64('x'.repeat(9000)) } },
    ] };
    const text = extractBody(payload);
    expect(text.length).toBeLessThan(8100);
    expect(text).toMatch(/email truncated/);
  });
});

describe('buildMime', () => {
  it('encodes non-ASCII subjects, blocks header injection, adds reply headers', () => {
    const raw = buildMime({ from: 'me@gmail.com', to: 'a@x.com\r\nBcc: evil@x.com', subject: 'Late — sorry', body: 'Hi ✓', inReplyTo: '<abc@mail>', references: '<abc@mail>' });
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const [head, body] = text.split('\r\n\r\n');
    expect(head).not.toMatch(/\r\nBcc:/);
    expect(head).toContain('To: a@x.com Bcc: evil@x.com');
    expect(head).toContain(`Subject: ${encodeHeader('Late — sorry')}`);
    expect(encodeHeader('Late — sorry')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeader('plain')).toBe('plain');
    expect(head).toContain('In-Reply-To: <abc@mail>');
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hi ✓');
  });
});

describe('GmailClient.send', () => {
  it('sends a new email from the account', async () => {
    const { gmail, calls } = client([{ match: '/messages/send', method: 'POST', reply: { id: 's1', threadId: 'ts1' } }]);
    expect(await gmail.send(acct, { to: 'sir@c.edu', subject: 'Late', body: 'Running late' })).toEqual({ id: 's1', threadId: 'ts1' });
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.threadId).toBeUndefined();
    const mime = Buffer.from(sent.raw, 'base64url').toString('utf8');
    expect(mime).toContain('From: me@gmail.com');
    expect(mime).toContain('Subject: Late');
  });

  it('replies in the original thread', async () => {
    const { gmail, calls } = client([
      { match: '/messages/m1?format=metadata', reply: meta('m1', 'Sir <sir@c.edu>', 'Class moved', { extra: { 'Message-ID': '<orig@c>' } }) },
      { match: '/messages/send', method: 'POST', reply: { id: 's2', threadId: 'tm1' } },
    ]);
    await gmail.send(acct, { to: 'sir@c.edu', subject: '', body: 'Thanks', replyTo: 'm1' });
    const sent = JSON.parse(calls.at(-1).init.body);
    expect(sent.threadId).toBe('tm1');
    const mime = Buffer.from(sent.raw, 'base64url').toString('utf8');
    expect(mime).toContain('Subject: Re: Class moved');
    expect(mime).toContain('In-Reply-To: <orig@c>');
  });
});
```

- [ ] Run — FAIL. Implement:

```js
// server/google/gmail.js
import { UserFacingError } from '../errors.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 8000;
const DEFAULT_QUERY = 'in:inbox newer_than:7d';

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decodeEntities = (s) => String(s || '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => {
  if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return m;
});

export function htmlToText(html) {
  const text = decodeEntities(String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  return lines.filter((l, i) => l || (i > 0 && lines[i - 1])).join('\n').trim();
}

const decode = (data) => Buffer.from(String(data || ''), 'base64url').toString('utf8');

export function extractBody(payload) {
  const found = {};
  (function walk(part) {
    if (!part) return;
    const isAttachment = Boolean(part.filename);
    if (!isAttachment && part.body?.data) {
      if (part.mimeType === 'text/plain' && found.plain === undefined) found.plain = decode(part.body.data);
      if (part.mimeType === 'text/html' && found.html === undefined) found.html = decode(part.body.data);
    }
    for (const p of part.parts || []) walk(p);
  })(payload);
  let text = (found.plain !== undefined ? found.plain : htmlToText(found.html || '')).replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY)}\n… (email truncated)`;
  return text;
}

export function header(message, name) {
  const h = (message?.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function summarize(m) {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, 'From'),
    subject: header(m, 'Subject') || '(no subject)',
    date: header(m, 'Date'),
    snippet: decodeEntities(m.snippet || ''),
    unread: (m.labelIds || []).includes('UNREAD'),
  };
}

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

export function encodeHeader(s) {
  const v = clean(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

export function buildMime({ from, to, cc, subject, body, inReplyTo, references }) {
  const lines = [`From: ${clean(from)}`, `To: ${clean(to)}`];
  if (cc) lines.push(`Cc: ${clean(cc)}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${clean(inReplyTo)}`, `References: ${clean(references || inReplyTo)}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
  lines.push(Buffer.from(String(body ?? ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function gmailError(status) {
  if (status === 401) return "Gmail rejected Novi's access — reconnect this account in Settings.";
  if (status === 403) return 'Gmail refused that request (permission or quota).';
  if (status === 404) return "I couldn't find that email.";
  if (status === 429) return 'Gmail is rate-limiting Novi; try again in a minute.';
  return `Gmail had a problem (${status}).`;
}

export class GmailClient {
  constructor({ getToken, invalidate = () => {}, fetchImpl = fetch }) {
    this.getToken = getToken;
    this.invalidate = invalidate;
    this.fetchImpl = fetchImpl;
  }

  async _call(account, pathAndQuery, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(account);
      let res;
      try {
        res = await this.fetchImpl(`${API}${pathAndQuery}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new UserFacingError(`I couldn't reach Gmail: ${err.message}`);
      }
      if (res.status === 401 && attempt === 0) {
        this.invalidate(account);
        continue;
      }
      if (!res.ok) throw new UserFacingError(gmailError(res.status));
      return res.json();
    }
  }

  async search(account, { query = DEFAULT_QUERY, max = 10 } = {}) {
    const q = query || DEFAULT_QUERY;
    const list = await this._call(account, `/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(Math.max(Number(max) || 10, 1), 25)}`);
    const ids = (list.messages || []).map((m) => m.id);
    const fields = ['From', 'To', 'Subject', 'Date'].map((h) => `metadataHeaders=${h}`).join('&');
    const metas = await Promise.all(ids.map((id) => this._call(account, `/messages/${encodeURIComponent(id)}?format=metadata&${fields}`)));
    return metas.map(summarize);
  }

  async read(account, id) {
    const m = await this._call(account, `/messages/${encodeURIComponent(id)}?format=full`);
    return { ...summarize(m), to: header(m, 'To'), cc: header(m, 'Cc'), body: extractBody(m.payload) };
  }

  async send(account, { to, cc, subject, body, replyTo }) {
    let threadId;
    let inReplyTo;
    let references;
    let finalSubject = subject;
    if (replyTo) {
      const fields = ['Message-ID', 'Subject', 'References'].map((h) => `metadataHeaders=${h}`).join('&');
      const orig = await this._call(account, `/messages/${encodeURIComponent(replyTo)}?format=metadata&${fields}`);
      threadId = orig.threadId;
      inReplyTo = header(orig, 'Message-ID');
      references = [header(orig, 'References'), inReplyTo].filter(Boolean).join(' ');
      const base = finalSubject || header(orig, 'Subject') || '';
      finalSubject = /^re:/i.test(base) ? base : `Re: ${base}`;
    }
    const raw = buildMime({ from: account.email, to, cc, subject: finalSubject, body, inReplyTo, references });
    const sent = await this._call(account, '/messages/send', { method: 'POST', body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
    return { id: sent.id, threadId: sent.threadId };
  }
}
```

- [ ] Run — PASS. Commit `feat: Gmail REST client (search, read, send, reply)`.

---

### Task 5: Account tools + agent precheck/detail/privacy

**Files:** Create `server/tools/accountTools.js`, `tests/server/accountTools.test.js`. Modify `server/brain/agent.js`, `tests/server/agent.test.js`.

**Consumes:** `resolveAccount`, `askNote` (Task 2), `GoogleAuth.connect` (Task 3), `GmailClient` (Task 4).
**Produces:** `addAccountTools(registry, { accounts, auth, gmail, onConnected?, onConnectError? }) → registry` with tools `accounts_list`, `accounts_set_default`, `accounts_rename`, `gmail_connect`, `gmail_search`, `gmail_read`, `gmail_send`. Tool shape gains optional `precheck(args) → Promise<object|null>` and `detail(args) → string`. Agent options gain `privateProviders` (default `['groq']`) and `accounts` (registry, optional); `systemPrompt({projects, task, accounts})`.

- [ ] Write `tests/server/accountTools.test.js`:

```js
// tests/server/accountTools.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addAccountTools } from '../../server/tools/accountTools.js';
import { ToolRegistry } from '../../server/tools/registry.js';
import { AccountRegistry } from '../../server/accounts/registry.js';
import { UserFacingError } from '../../server/errors.js';

function setup({ accounts: list = [['personal', 'p@gmail.com'], ['college', 'c@college.edu']], defaultLabel } = {}) {
  const accounts = new AccountRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-at-')), 'a.json'));
  for (const [label, email] of list) accounts.setLabel(accounts.add({ provider: 'google', email }).id, label);
  if (defaultLabel) accounts.setDefault('google', accounts.list().find((a) => a.label === defaultLabel).id);
  const calls = [];
  const gmail = {
    search: async (acc, opts) => { calls.push(['search', acc.label, opts]); return [{ id: `m-${acc.label}`, from: 'Sir', subject: 'Hi', date: 'd', snippet: 's', unread: true }]; },
    read: async (acc, id) => { calls.push(['read', acc.label, id]); return { id, from: 'Sir', subject: 'Hi', body: 'secret body' }; },
    send: async (acc, msg) => { calls.push(['send', acc.label, msg]); return { id: 's1' }; },
  };
  let finishConnect;
  const connected = [];
  const auth = { connect: async () => ({ url: 'https://accounts.google.com/x', done: new Promise((r) => { finishConnect = r; }) }) };
  const tools = addAccountTools(new ToolRegistry(), { accounts, auth, gmail, onConnected: (a) => connected.push(a) });
  return { tools, accounts, calls, connected, finishConnect: (a) => finishConnect(a) };
}

describe('account tools', () => {
  it('only sending needs approval', () => {
    const { tools } = setup();
    expect(tools.get('gmail_send').tier).toBe('medium');
    for (const n of ['accounts_list', 'accounts_set_default', 'accounts_rename', 'gmail_connect', 'gmail_search', 'gmail_read']) expect(tools.get(n).tier).toBe('low');
  });

  it('gmail_search asks which account when several are connected and none is default', async () => {
    const { tools, calls } = setup();
    const out = await tools.get('gmail_search').run({});
    expect(out.ask).toEqual([{ label: 'personal', email: 'p@gmail.com' }, { label: 'college', email: 'c@college.edu' }]);
    expect(out.note).toBe('Which account: personal (p@gmail.com) or college (c@college.edu)?');
    expect(calls).toEqual([]);
  });

  it('gmail_search uses the named account and marks results sensitive', async () => {
    const { tools, calls } = setup();
    const out = await tools.get('gmail_search').run({ account: 'college', query: 'is:unread' });
    expect(out.sensitive).toBe(true);
    expect(out.messages).toEqual([{ account: 'college', id: 'm-college', from: 'Sir', subject: 'Hi', date: 'd', snippet: 's', unread: true }]);
    expect(calls[0]).toEqual(['search', 'college', { query: 'is:unread', max: 10 }]);
  });

  it('gmail_search "all" searches every account; the default is used when set', async () => {
    const all = setup();
    const out = await all.tools.get('gmail_search').run({ account: 'all' });
    expect(out.messages.map((m) => m.account)).toEqual(['personal', 'college']);
    const def = setup({ defaultLabel: 'personal' });
    await def.tools.get('gmail_search').run({});
    expect(def.calls[0][1]).toBe('personal');
  });

  it('expired accounts ask to reconnect', async () => {
    const { tools, accounts } = setup({ accounts: [['personal', 'p@gmail.com']] });
    accounts.markExpired(accounts.list()[0].id);
    await expect(tools.get('gmail_search').run({})).rejects.toThrow(/reconnect/);
  });

  it('unknown account names are explained', async () => {
    const { tools } = setup();
    await expect(tools.get('gmail_read').run({ id: 'm1', account: 'work' })).rejects.toThrow(UserFacingError);
  });

  it('gmail_read returns the message as sensitive', async () => {
    const { tools } = setup({ defaultLabel: 'college' });
    expect(await tools.get('gmail_read').run({ id: 'm9' })).toEqual({ sensitive: true, account: 'college', message: { id: 'm9', from: 'Sir', subject: 'Hi', body: 'secret body' } });
  });

  it('gmail_send asks for the account before approval, then shows sender, recipient and full body', async () => {
    const { tools, calls } = setup();
    const send = tools.get('gmail_send');
    const args = { to: 'sir@c.edu', subject: 'Late', body: 'I will be 10 minutes late.' };
    expect((await send.precheck(args)).ask).toHaveLength(2);
    const chosen = { ...args, account: 'college' };
    expect(await send.precheck(chosen)).toBeNull();
    expect(send.describe(chosen)).toBe('Send from college (c@college.edu) to sir@c.edu: Late');
    expect(send.detail(chosen)).toBe('I will be 10 minutes late.');
    expect(send.detail({ ...chosen, cc: 'mom@x.com' })).toBe('Cc: mom@x.com\n\nI will be 10 minutes late.');
    expect(await send.run(chosen)).toMatchObject({ sent: true, from: 'college', to: 'sir@c.edu' });
    expect(calls).toEqual([['send', 'college', { to: 'sir@c.edu', cc: undefined, subject: 'Late', body: 'I will be 10 minutes late.', replyTo: undefined }]]);
  });

  it('gmail_send precheck reports unknown accounts without asking for approval', async () => {
    const { tools } = setup();
    expect((await tools.get('gmail_send').precheck({ to: 'a@b.c', subject: 's', body: 'b', account: 'work' })).error).toMatch(/No Gmail account called "work"/);
  });

  it('sets and clears the default by voice; lists accounts with the default flag', async () => {
    const { tools } = setup();
    expect(await tools.get('accounts_set_default').run({ service: 'gmail', account: 'college' })).toEqual({ default: 'college' });
    const listed = await tools.get('accounts_list').run({});
    expect(listed.accounts.find((a) => a.label === 'college').default).toBe(true);
    expect(await tools.get('accounts_set_default').run({ account: 'none' })).toEqual({ default: null });
    expect((await tools.get('accounts_list').run({})).accounts.every((a) => !a.default)).toBe(true);
  });

  it('renames accounts', async () => {
    const { tools } = setup();
    expect(await tools.get('accounts_rename').run({ account: 'college', label: 'Uni' })).toEqual({ renamed: 'uni' });
  });

  it('gmail_connect opens consent and reports when connected', async () => {
    const { tools, connected, finishConnect } = setup();
    const out = await tools.get('gmail_connect').run({});
    expect(out.note).toMatch(/opened Google's sign-in page/);
    finishConnect({ email: 'new@gmail.com', label: 'new' });
    await new Promise((r) => setTimeout(r, 0));
    expect(connected).toEqual([{ email: 'new@gmail.com', label: 'new' }]);
  });
});
```

- [ ] Add to `tests/server/agent.test.js` (before `describe('describeStatus'`):

```js
describe('Agent account features', () => {
  function build(steps, { tool, privateProviders } = {}) {
    const router = scriptedRouter(steps);
    const approvals = new ApprovalQueue();
    const requested = [];
    approvals.on('added', (a) => { requested.push(a); approvals.resolve(a.id, true); });
    const tools = new ToolRegistry().add(tool);
    const agent = new Agent({ router, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }), stop: async () => false }, privateProviders });
    return { agent, router, requested };
  }

  it('precheck can answer instead of asking for approval', async () => {
    const tool = { name: 'send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send', precheck: async () => ({ ask: ['a', 'b'], note: 'Which account?' }), run: async () => { throw new Error('must not run'); } };
    const { agent, router, requested } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('send', {})] }, provider: 'groq', model: 'm' }, reply('Which account?')], { tool });
    expect(await agent.handle('send it')).toBe('Which account?');
    expect(requested).toEqual([]);
    expect(JSON.parse(router.calls[1].messages.at(-1).content)).toEqual({ ask: ['a', 'b'], note: 'Which account?' });
  });

  it('puts the tool detail (e.g. the full email) in the approval', async () => {
    const tool = { name: 'send', description: 's', parameters: { type: 'object', properties: {} }, tier: 'medium', describe: () => 'Send from college to sir', detail: (a) => a.body, run: async () => ({ sent: true }) };
    const { agent, requested } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('send', { body: 'Full email text' })] }, provider: 'groq', model: 'm' }, reply('Sent.')], { tool });
    await agent.handle('send it');
    expect(requested[0]).toMatchObject({ title: 'Send from college to sir', detail: 'Full email text' });
  });

  it('never passes sensitive results to a non-private provider', async () => {
    const tool = { name: 'mail', description: 'm', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'mail', run: async () => ({ sensitive: true, messages: ['secret'] }) };
    const { agent, router } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('mail', {})] }, provider: 'gemini', model: 'g' }], { tool });
    expect(await agent.handle('check my mail')).toBe("I can't read your mail right now — my private AI provider is busy. Try again in a minute.");
    expect(router.calls).toHaveLength(1);
  });

  it('continues on the private provider', async () => {
    const tool = { name: 'mail', description: 'm', parameters: { type: 'object', properties: {} }, tier: 'low', describe: () => 'mail', run: async () => ({ sensitive: true, messages: ['secret'] }) };
    const { agent, router } = build([{ message: { role: 'assistant', content: null, tool_calls: [toolCall('mail', {})] }, provider: 'groq', model: 'm' }, reply('One new email from Sir.')], { tool });
    expect(await agent.handle('check my mail')).toBe('One new email from Sir.');
    expect(router.calls[1].only).toBe('groq');
    expect(agent.history.map((m) => m.content)).toEqual(['check my mail', 'One new email from Sir.']);
  });

  it('mentions connected accounts and Gmail tools in the system prompt', async () => {
    const { systemPrompt } = await import('../../server/brain/agent.js');
    const p = systemPrompt({ projects: [], task: { active: false }, accounts: [{ provider: 'google', label: 'college', email: 'c@college.edu', isDefault: true }] });
    expect(p).toContain('gmail_search');
    expect(p).toContain('college (c@college.edu, default)');
    expect(p).toMatch(/ask the user which account/i);
  });
});
```

- [ ] Run both — FAIL. Implement `server/tools/accountTools.js`:

```js
// server/tools/accountTools.js
import { UserFacingError } from '../errors.js';
import { resolveAccount, askNote } from '../accounts/resolve.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const SERVICES = { gmail: 'google', google: 'google', email: 'google' };
const ACCOUNT = str('Account label or email (e.g. "college"); omit to use the default or the only one');

const expiredMessage = (a) => `Your ${a.label} Gmail connection expired — reconnect it in Settings.`;

function pick(accounts, requested, opts) {
  const r = resolveAccount(accounts, 'google', requested, opts);
  if (r.error) throw new UserFacingError(r.error);
  return r;
}

function usable(account) {
  if (account.status === 'expired') throw new UserFacingError(expiredMessage(account));
  return account;
}

export function addAccountTools(registry, { accounts, auth, gmail, onConnected = () => {}, onConnectError = () => {} }) {
  return registry
    .add({
      name: 'accounts_list',
      description: 'List connected accounts (Gmail): labels, emails, which one is the default, and whether any expired.',
      parameters: obj(),
      tier: 'low',
      describe: () => 'List accounts',
      run: async () => ({
        accounts: accounts.list().map((a) => ({ service: a.provider === 'google' ? 'gmail' : a.provider, label: a.label, email: a.email, status: a.status, default: accounts.defaultFor(a.provider)?.id === a.id })),
      }),
    })
    .add({
      name: 'accounts_set_default',
      description: 'Set which account Novi uses by default for a service, or clear it (account "none") so Novi asks each time.',
      parameters: obj({ service: str('Service, e.g. "gmail"'), account: str('Account label or email, or "none" to clear') }, ['account']),
      tier: 'low',
      describe: ({ account }) => `Default account: ${account}`,
      run: async ({ service = 'gmail', account }) => {
        const provider = SERVICES[String(service).toLowerCase()] || 'google';
        if (!account || /^(none|clear|no default|nobody)$/i.test(String(account).trim())) {
          accounts.setDefault(provider, null);
          return { default: null };
        }
        const { account: chosen } = pick(accounts, account);
        accounts.setDefault(provider, chosen.id);
        return { default: chosen.label };
      },
    })
    .add({
      name: 'accounts_rename',
      description: 'Rename a connected account (its label), e.g. call c@college.edu "college".',
      parameters: obj({ account: str('Current label or email'), label: str('New label') }, ['account', 'label']),
      tier: 'low',
      describe: ({ account, label }) => `Rename ${account} to ${label}`,
      run: async ({ account, label }) => {
        const { account: target } = pick(accounts, account);
        return { renamed: accounts.setLabel(target.id, label).label };
      },
    })
    .add({
      name: 'gmail_connect',
      description: "Connect a Gmail account: opens Google's sign-in page on the laptop, where the user picks the account and allows Novi.",
      parameters: obj(),
      tier: 'low',
      describe: () => 'Connect Gmail',
      run: async () => {
        const { done } = await auth.connect();
        done.then(onConnected, onConnectError);
        return { note: "I've opened Google's sign-in page on the laptop. Pick the account and allow Novi; I'll tell you when it's connected." };
      },
    })
    .add({
      name: 'gmail_search',
      description: 'Search Gmail. query uses Gmail search syntax (from:, to:, subject:, is:unread, newer_than:2d); default is the last 7 days of the inbox. account "all" searches every connected account.',
      parameters: obj({ query: str('Gmail search query'), account: str('Account label/email, "all", or omit'), max: { type: 'integer', description: 'Max results per account (default 10, max 25)' } }),
      tier: 'low',
      describe: ({ query }) => `Search Gmail${query ? ` for ${query}` : ''}`,
      run: async ({ query, account, max }) => {
        const r = pick(accounts, account, { allowAll: true });
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        const targets = (r.accounts || [r.account]).map(usable);
        const messages = [];
        for (const acc of targets) {
          for (const m of await gmail.search(acc, { query, max: max || 10 })) messages.push({ account: acc.label, ...m });
        }
        return { sensitive: true, query: query || 'in:inbox newer_than:7d', messages };
      },
    })
    .add({
      name: 'gmail_read',
      description: 'Read one email in full (use an id from gmail_search, with the same account).',
      parameters: obj({ id: str('Message id from gmail_search'), account: ACCOUNT }, ['id']),
      tier: 'low',
      describe: () => 'Read an email',
      run: async ({ id, account }) => {
        const r = pick(accounts, account);
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        const acc = usable(r.account);
        return { sensitive: true, account: acc.label, message: await gmail.read(acc, id) };
      },
    })
    .add({
      name: 'gmail_send',
      description: "Send an email, or reply when reply_to_id is given (keeps the thread). Write the complete email; the user sees it with the sending account and must approve it. Never guess addresses — ask.",
      parameters: obj({
        to: str('Recipient email address(es), comma-separated'),
        subject: str('Subject (for replies it can be empty)'),
        body: str('Complete plain-text email body'),
        cc: str('Cc addresses, optional'),
        reply_to_id: str('Message id being replied to, optional'),
        account: ACCOUNT,
      }, ['to', 'body']),
      tier: 'medium',
      precheck: async ({ account }) => {
        const r = resolveAccount(accounts, 'google', account);
        if (r.error) return { error: r.error, note: r.error };
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        if (r.account.status === 'expired') return { error: expiredMessage(r.account), note: expiredMessage(r.account) };
        return null;
      },
      describe: ({ account, to, subject }) => {
        const a = resolveAccount(accounts, 'google', account).account;
        return `Send from ${a ? `${a.label} (${a.email})` : 'Gmail'} to ${to}${subject ? `: ${subject}` : ''}`;
      },
      detail: ({ cc, body }) => `${cc ? `Cc: ${cc}\n\n` : ''}${body ?? ''}`,
      run: async ({ to, subject, body, cc, reply_to_id: replyTo, account }) => {
        const acc = usable(pick(accounts, account).account);
        const sent = await gmail.send(acc, { to, cc, subject, body, replyTo });
        return { sent: true, from: acc.label, to, id: sent.id };
      },
    });
}
```

- [ ] Modify `server/brain/agent.js`:
  1. `systemPrompt({ projects, task, accounts = [] })` — append two lines:

```js
    'For email use gmail_search (Gmail search syntax), gmail_read and gmail_send; gmail_connect connects a new account. If a tool result contains "ask", ask the user which account and call the tool again with account. Never guess email addresses. Write the complete email before gmail_send; the user approves it on screen. When summarising mail, mention sender and subject briefly.',
    `Connected accounts: ${accounts.length ? accounts.map((a) => `Gmail ${a.label} (${a.email}${a.isDefault ? ', default' : ''}${a.status === 'expired' ? ', expired' : ''})`).join('; ') : 'none'}.`,
```

  2. Constructor: `constructor({ router, tools, approvals, memory, tasks, accounts = null, privateProviders = ['groq'] })`, store both.
  3. In `handle`, build the prompt with `accounts: this._accountsForPrompt()` where

```js
  _accountsForPrompt() {
    if (!this.accounts) return [];
    return this.accounts.list().map((a) => ({ ...a, isDefault: this.accounts.defaultFor(a.provider)?.id === a.id }));
  }
```

  4. In the tool loop, track sensitivity and stop before sending it to a non-private provider:

```js
      let sensitive = false;
      for (const call of calls) {
        const result = await this._runTool(call);
        if (result.note) notes.push(result.note);
        if (result.output?.sensitive) sensitive = true;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.output) });
      }
      if (sensitive && !this.privateProviders.includes(provider)) {
        return this._remember(text, "I can't read your mail right now — my private AI provider is busy. Try again in a minute.");
      }
```

  5. In `_runTool`, after argument parsing and before the approval request:

```js
    if (tool.precheck) {
      const pre = await tool.precheck(args);
      if (pre) return { output: pre, note: pre.note };
    }
```
     and pass `detail: tool.detail ? tool.detail(args) : ''` in `this.approvals.request({...})`.

- [ ] Run accountTools + agent tests — PASS; full suite green. Commit `feat: Gmail and account tools; agent precheck, approval detail, mail privacy routing`.

---

### Task 6: Server wiring + Settings → Accounts UI

**Files:** Modify `server/app.js`, `tests/server/app.test.js`, `src/lib/useNovi.js`, `src/App.jsx`, `src/components/SettingsDrawer.jsx`, `src/styles.css`.

- [ ] Add to `tests/server/app.test.js` inside `describe('Novi server')`:

```js
  it('includes accounts in the snapshot and refuses to connect Gmail without credentials', async () => {
    const { base, ws } = await start();
    const c = connect(ws);
    const snap = await c.waitFor((m) => m.type === 'snapshot');
    expect(snap.accounts).toEqual([]);
    expect(snap.googleConfigured).toBe(false);
    c.ws.close();
    const res = await fetch(`${base}/api/accounts/google/connect`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it('registers the Gmail tools for the brain', async () => {
    const { novi } = await start();
    for (const name of ['gmail_search', 'gmail_read', 'gmail_send', 'gmail_connect', 'accounts_list']) expect(novi.tools.get(name)).toBeTruthy();
  });

  it('renames, sets default and disconnects accounts via the API', async () => {
    const { base, novi } = await start();
    const a = novi.accounts.add({ provider: 'google', email: 'c@college.edu' });
    const patch = await fetch(`${base}/api/accounts/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'College', default: true }) });
    expect(patch.status).toBe(200);
    expect(novi.accounts.get(a.id).label).toBe('college');
    expect(novi.accounts.defaultFor('google').id).toBe(a.id);
    expect((await fetch(`${base}/api/accounts/nope`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/api/accounts/${a.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(novi.accounts.list()).toEqual([]);
  });
```

  and in the test `start()` helper pass `cipher: { protect: async (s) => `enc:${s}`, unprotect: async (s) => s.slice(4) }` in the overrides.

- [ ] Run — FAIL. In `server/app.js`:
  - imports: `AccountRegistry`, `SecretStore`, `defaultCipher`, `GoogleAuth`, `GmailClient`, `addAccountTools`.
  - after `memory`:

```js
  const accounts = overrides.accounts || new AccountRegistry(path.join(config.dataDir, 'accounts.json'));
  const secrets = new SecretStore({ file: path.join(config.dataDir, 'secrets.json'), cipher: overrides.cipher || defaultCipher(config.dataDir) });
  const auth = overrides.auth || new GoogleAuth({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, accounts, secrets });
  const gmail = new GmailClient({ getToken: (a) => auth.accessToken(a), invalidate: (a) => auth.invalidate(a.id) });
```

  - tools: `const tools = addAccountTools(addLaptopTools(createNoviTools({ memory, tasks }), overrides.laptop), { accounts, auth, gmail, onConnected: (a) => onConnected(a), onConnectError: (e) => onConnectError(e) });`
  - agent: add `accounts, privateProviders: config.privateProviders || ['groq']`.
  - snapshot adds `accounts: accountsView(), googleConfigured: auth.configured`, with

```js
  const accountsView = () => accounts.list().map((a) => ({ id: a.id, provider: a.provider, label: a.label, email: a.email, status: a.status, isDefault: accounts.defaultFor(a.provider)?.id === a.id }));
  const onConnected = (a) => {
    const text = `Gmail connected: ${a.email}. I'll call it ${a.label}.`;
    say('novi', text);
    broadcast({ type: 'speak', text });
    broadcast(snapshot());
  };
  const onConnectError = (e) => {
    say('novi', e.message);
    broadcast({ type: 'speak', text: e.message });
  };
```

  - routes (after the `/api` auth middleware):

```js
  app.post('/api/accounts/google/connect', async (req, res) => {
    try {
      const { url, done } = await auth.connect();
      done.then(onConnected, onConnectError);
      res.json({ url });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.patch('/api/accounts/:id', (req, res) => {
    const account = accounts.get(req.params.id);
    if (!account) return res.status(404).json({ error: 'No such account' });
    try {
      if (typeof req.body?.label === 'string') accounts.setLabel(account.id, req.body.label);
      if (req.body?.default === true) accounts.setDefault(account.provider, account.id);
      if (req.body?.default === false) accounts.setDefault(account.provider, null);
      res.json({ ok: true });
      broadcast(snapshot());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete('/api/accounts/:id', async (req, res) => {
    if (!accounts.get(req.params.id)) return res.status(404).json({ error: 'No such account' });
    await auth.disconnect(req.params.id);
    res.json({ removed: true });
    broadcast(snapshot());
  });
```

  - return value adds `accounts`.

- [ ] UI: `src/lib/useNovi.js` `initialState` add `accounts: [], googleConfigured: false`. `src/App.jsx` passes `accounts={state.accounts} googleConfigured={state.googleConfigured}` to `SettingsDrawer`. In `SettingsDrawer.jsx` import `Pencil` from lucide-react, accept `accounts = [], googleConfigured`, add before the Projects section:

```jsx
        <section>
          <h3>Accounts</h3>
          {!googleConfigured && <p className="muted">Gmail isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart Novi.</p>}
          {googleConfigured && accounts.length === 0 && <p className="muted">No accounts connected yet.</p>}
          <ul className="list">
            {accounts.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>
                    {a.label}
                    {a.isDefault && <span className="badge done">default</span>}
                    {a.status === 'expired' && <span className="badge failed">expired</span>}
                  </strong>
                  <span className="muted">Gmail · {a.email}</span>
                </div>
                <div className="row-actions">
                  {!a.isDefault && <button className="btn" onClick={() => patchAccount(a.id, { default: true })}>Make default</button>}
                  <button className="icon" aria-label={`Rename ${a.label}`} onClick={() => { const label = window.prompt('New name for this account', a.label); if (label) patchAccount(a.id, { label }); }}><Pencil size={16} /></button>
                  <button className="icon" aria-label={`Disconnect ${a.label}`} onClick={() => { if (window.confirm(`Disconnect ${a.email}? Novi will lose access to this Gmail.`)) api(`/api/accounts/${a.id}`, { method: 'DELETE' }); }}><Trash2 size={16} /></button>
                </div>
              </li>
            ))}
          </ul>
          <button className="btn primary" disabled={!googleConfigured} onClick={connectGmail}>Connect Gmail</button>
          {accountMsg && <p className="muted">{accountMsg}</p>}
        </section>
```

  with, inside the component:

```jsx
  const [accountMsg, setAccountMsg] = useState(null);
  const patchAccount = async (id, body) => {
    const res = await api(`/api/accounts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) setAccountMsg((await res.json().catch(() => ({}))).error || 'That did not work.');
  };
  const connectGmail = async () => {
    const res = await api('/api/accounts/google/connect', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    setAccountMsg(res.ok ? 'Finish signing in in the browser window that opened on the laptop.' : body.error || 'Could not start the Gmail connection.');
  };
```

  `src/styles.css` append:

```css
.row-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
.list strong .badge { margin-left: 6px; }
.approval .detail { white-space: pre-wrap; max-height: 40vh; overflow-y: auto; }
```

- [ ] Run full suite — PASS; `npm run build` — OK. Commit `feat: Settings → Accounts and Gmail wiring`.

---

### Task 7: Live verification (read-only) + docs

- [ ] Restart Novi; Settings shows Accounts with "Connect Gmail" enabled.
- [ ] User clicks Connect Gmail (or says "connect my Gmail"), completes Google consent (Advanced → Go to Novi → Allow). Expected: spoken "Gmail connected: …", account listed.
- [ ] `data/secrets.json` contains no plain refresh token (check it is a DPAPI blob) — inspect without printing the value (length + `startsWith('AQAAANCMnd8')`).
- [ ] Say "summarize my inbox" → Novi lists senders/subjects; feed/server log shows provider groq.
- [ ] Say "read me the first one" → summary of that email.
- [ ] No real send unless the user asks; if they do, the approval card shows account, recipient and full body.
- [ ] README: add a "Gmail" section (setup steps, what Novi can do, privacy). Commit `docs: Gmail setup and usage`.
