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

// One Google sign-in for everything Novi uses: Gmail plus Calendar events and Tasks (plugins/google).
export const GOOGLE_SCOPES = [
  ...GMAIL_SCOPES,
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge, scopes = GOOGLE_SCOPES }) {
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
