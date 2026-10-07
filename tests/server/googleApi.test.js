import { describe, it, expect } from 'vitest';
import { createGoogleApi } from '../../server/google/api.js';

const account = { id: 'a1', label: 'me' };
const res = (status, body = {}) => new Response(JSON.stringify(body), { status });

describe('google api helper (runtime.google)', () => {
  it('calls Google with the account\'s access token and JSON body', async () => {
    const seen = [];
    const api = createGoogleApi({ auth: { configured: true, accessToken: async () => 'tok', invalidate() {} }, accounts: null, fetchImpl: async (url, init) => { seen.push({ url, init }); return res(200, { ok: 1 }); } });
    expect(await api.call(account, 'https://x/y', { method: 'POST', body: '{"a":1}' })).toEqual({ ok: 1 });
    expect(seen[0].init.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  });

  it('refreshes the token once on 401', async () => {
    let n = 0;
    const invalidated = [];
    const api = createGoogleApi({ auth: { configured: true, accessToken: async () => `tok${++n}`, invalidate: (id) => invalidated.push(id) }, fetchImpl: async (url, init) => (init.headers.Authorization === 'Bearer tok1' ? res(401) : res(200, { ok: 2 })) });
    expect(await api.call(account, 'https://x')).toEqual({ ok: 2 });
    expect(invalidated).toEqual(['a1']);
  });

  it('turns API errors into plain messages (e.g. API not enabled)', async () => {
    const api = createGoogleApi({ auth: { configured: true, accessToken: async () => 't', invalidate() {} }, fetchImpl: async () => res(403, { error: { message: 'Google Calendar API has not been used in project 123 before or it is disabled.' } }) });
    await expect(api.call(account, 'https://www.googleapis.com/calendar/v3/x')).rejects.toThrow(/turn on the Google Calendar API/i);
  });
});
