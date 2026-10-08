import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth, buildAuthUrl, startLoopback, GMAIL_SCOPES, emailFromIdToken , GOOGLE_SCOPES } from '../../server/google/oauth.js';
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
      client_id: 'cid', redirect_uri: 'http://127.0.0.1:1/callback', response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
      code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', access_type: 'offline', prompt: 'consent',
    });
  });

  it('also asks for Calendar and Tasks (one Google sign-in for everything)', () => {
    expect(GOOGLE_SCOPES).toEqual(expect.arrayContaining([...GMAIL_SCOPES, 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/tasks', 'https://www.googleapis.com/auth/drive.file']));
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
