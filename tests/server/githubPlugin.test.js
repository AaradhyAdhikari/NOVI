import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';
import { AccountRegistry } from '../../server/accounts/registry.js';
import { resolveAccount, askNote } from '../../server/accounts/resolve.js';
import { createGithubPlugin } from '../../plugins/github/index.js';
import { pollForToken } from '../../plugins/github/github.js';

function memorySecrets() {
  const map = new Map();
  return { map, set: async (id, v) => { map.set(id, v); }, get: async (id) => map.get(id) ?? null, delete: (id) => map.delete(id) };
}

// routes: [{ method?, match: RegExp, reply: object | (url, init, calls) => object }]
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, body: init.body ? String(init.body) : null, headers: init.headers || {} });
    const route = routes.find((r) => (r.method || 'GET') === method && r.match.test(String(url)));
    if (!route) throw new Error(`no route for ${method} ${url}`);
    const out = typeof route.reply === 'function' ? route.reply(String(url), init, calls) : route.reply;
    const status = out.status || 200;
    return new Response(status === 204 || status === 205 ? null : JSON.stringify(out.body ?? out), { status });
  };
  return { fetchImpl, calls };
}

async function setup({ routes = [], logins = ['octo'], clientId = 'Ov23liTEST', defaultLogin } = {}) {
  const accounts = new AccountRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novi-gh-')), 'a.json'));
  const secrets = memorySecrets();
  for (const login of logins) {
    const a = accounts.add({ provider: 'github', email: login, scopes: ['repo'] });
    await secrets.set(a.id, `token-${login}`);
  }
  if (defaultLogin) accounts.setDefault('github', accounts.list('github').find((a) => a.email === defaultLogin).id);
  const opened = [];
  const spoken = [];
  const { fetchImpl, calls } = fakeFetch(routes);
  const host = new PluginHost({
    logger: { warn() {} },
    env: clientId ? { NOVI_PLUGIN_GITHUB_CLIENT_ID: clientId } : {},
    runtime: {
      accounts,
      secrets,
      openUrl: async (u) => { opened.push(u); },
      speak: (t) => { spoken.push(t); },
      resolveAccount: (provider, requested, opts) => resolveAccount(accounts, provider, requested, opts),
      askNote,
    },
  });
  expect(host.register(createGithubPlugin({ fetchImpl, sleep: async () => {} }))).toBe(true);
  return { host, accounts, secrets, opened, spoken, calls };
}

const repo = (fullName, isPrivate = false) => ({ match: new RegExp(`/repos/${fullName}$`), reply: { full_name: fullName, private: isPrivate } });

describe('github plugin', () => {
  it('registers the GitHub tools declared in its manifest', async () => {
    const { host } = await setup();
    const manifest = JSON.parse(fs.readFileSync(path.resolve('plugins/github/openclaw.plugin.json'), 'utf8'));
    expect(host.plugins[0].tools.sort()).toEqual([...manifest.contracts.tools].sort());
    for (const name of ['github_connect', 'github_notifications', 'github_repos', 'github_issues', 'github_read']) expect(await host.get(name).gate({})).not.toHaveProperty('approval');
  });

  it('explains setup when the client ID is missing', async () => {
    const { host } = await setup({ clientId: null, logins: [] });
    const out = await host.get('github_connect').run({});
    expect(out.error).toMatch(/NOVI_PLUGIN_GITHUB_CLIENT_ID/);
  });

  it('connects with the device flow: shows the code, opens the page, stores the token', async () => {
    let polls = 0;
    const { host, accounts, secrets, opened, spoken, calls } = await setup({
      logins: [],
      routes: [
        { method: 'POST', match: /login\/device\/code$/, reply: { device_code: 'dev1', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } },
        { method: 'POST', match: /login\/oauth\/access_token$/, reply: () => { polls += 1; return polls === 1 ? { error: 'authorization_pending' } : polls === 2 ? { error: 'slow_down', interval: 10 } : { access_token: 'gho_abc', scope: 'repo,notifications,read:user' }; } },
        { match: /api\.github\.com\/user$/, reply: { login: 'Octo' } },
      ],
    });
    const out = await host.get('github_connect').run({});
    expect(out.user_code).toBe('WDJB-MJHT');
    expect(out.note).toMatch(/WDJB-MJHT/);
    expect(opened).toEqual(['https://github.com/login/device']);
    const deviceBody = new URLSearchParams(calls[0].body);
    expect(deviceBody.get('client_id')).toBe('Ov23liTEST');
    expect(deviceBody.get('scope')).toBe('repo notifications read:user');
    for (let i = 0; i < 50 && !spoken.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(spoken).toEqual(['GitHub connected as octo.']);
    const account = accounts.list('github')[0];
    expect(account).toMatchObject({ email: 'octo', label: 'octo', scopes: ['repo', 'notifications', 'read:user'] });
    expect(secrets.map.get(account.id)).toBe('gho_abc');
    expect(new URLSearchParams(calls.find((c) => /access_token/.test(c.url)).body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('counts your commits per repo for a day (for the Sheets log), read-only', async () => {
    const { host, calls } = await setup({
      routes: [{ match: /\/search\/commits\?/, reply: { total_count: 3, items: [
        { repository: { full_name: 'octo/NOVI', private: false } },
        { repository: { full_name: 'octo/NOVI', private: false } },
        { repository: { full_name: 'octo/FLEXR-', private: true } },
      ] } }],
    });
    expect(await host.get('github_activity').gate({ date: '2026-10-08' })).toEqual({});
    const out = await host.get('github_activity').run({ date: '2026-10-08' });
    expect(out.commits).toEqual([{ repo: 'octo/NOVI', count: 2 }, { repo: 'octo/FLEXR-', count: 1 }]);
    expect(decodeURIComponent(calls[0].url)).toContain('q=author:octo committer-date:2026-10-08');
  });

  it('lists notifications, marking private ones sensitive', async () => {
    const { host, calls } = await setup({
      routes: [{ match: /\/notifications\?/, reply: [
        { id: '1', unread: true, reason: 'mention', updated_at: 't', subject: { title: 'Fix login', type: 'Issue' }, repository: { full_name: 'octo/NOVI', private: true } },
        { id: '2', unread: false, reason: 'subscribed', updated_at: 't2', subject: { title: 'v2', type: 'Release' }, repository: { full_name: 'x/y', private: false } },
      ] }],
    });
    const out = await host.get('github_notifications').run({});
    expect(out.sensitive).toBe(true);
    expect(out.account).toBe('octo');
    expect(out.notifications[0]).toEqual({ id: '1', repo: 'octo/NOVI', title: 'Fix login', type: 'Issue', reason: 'mention', unread: true, updated: 't' });
    expect(calls[0].headers.Authorization).toBe('Bearer token-octo');
  });

  it('asks which account when several are connected and none is default', async () => {
    const { host, calls } = await setup({ logins: ['octo', 'work-bot'] });
    const out = await host.get('github_notifications').run({});
    expect(out.ask).toEqual([{ label: 'octo', email: 'octo' }, { label: 'work-bot', email: 'work-bot' }]);
    expect(calls).toEqual([]);
  });

  it('lists issues for a short repo name, filtering pull requests, not sensitive for public repos', async () => {
    const { host, calls } = await setup({
      routes: [
        repo('octo/NOVI'),
        { match: /\/repos\/octo\/NOVI\/issues\?/, reply: [
          { number: 3, title: 'Add TV casting', state: 'open', user: { login: 'octo' }, comments: 2, updated_at: 'u' },
          { number: 4, title: 'Gmail PR', state: 'open', user: { login: 'octo' }, comments: 0, updated_at: 'u', pull_request: {} },
        ] },
      ],
    });
    const issues = await host.get('github_issues').run({ repo: 'NOVI', type: 'issues' });
    expect(issues.sensitive).toBe(false);
    expect(issues.repo).toBe('octo/NOVI');
    expect(issues.items).toEqual([{ number: 3, title: 'Add TV casting', kind: 'issue', state: 'open', author: 'octo', comments: 2, updated: 'u' }]);
    expect(calls.some((c) => c.url.includes('state=open'))).toBe(true);
    const all = await host.get('github_issues').run({ repo: 'octo/NOVI' });
    expect(all.items.map((i) => i.kind)).toEqual(['issue', 'pull request']);
  });

  it('reads an issue with comments, private repos are sensitive, long text is capped', async () => {
    const { host } = await setup({
      routes: [
        repo('octo/secret', true),
        // GitHub issues have their own `body` field, so wrap the fake response explicitly.
        { match: /\/issues\/7$/, reply: { body: { number: 7, title: 'Bug', state: 'open', user: { login: 'a' }, body: 'x'.repeat(5000) } } },
        { match: /\/issues\/7\/comments\?/, reply: [{ user: { login: 'b' }, body: 'Same here', created_at: 'c' }] },
      ],
    });
    const out = await host.get('github_read').run({ repo: 'secret', number: 7 });
    expect(out.sensitive).toBe(true);
    expect(out.item.body.length).toBeLessThan(4100);
    expect(out.item.body).toMatch(/truncated/);
    expect(out.item.comments).toEqual([{ author: 'b', body: 'Same here', created: 'c' }]);
  });

  it('commenting needs approval showing the account, target and full comment', async () => {
    const { host, calls } = await setup({ routes: [{ method: 'POST', match: /\/repos\/octo\/NOVI\/issues\/3\/comments$/, reply: { html_url: 'https://github.com/octo/NOVI/issues/3#c1' } }] });
    const tool = host.get('github_comment');
    expect(await tool.gate({ repo: 'NOVI', number: 3, body: 'Fixed in v0.3' })).toEqual({ approval: { title: 'Comment on octo/NOVI#3 as octo', detail: 'Fixed in v0.3', tier: 'medium' } });
    expect(await tool.run({ repo: 'NOVI', number: 3, body: 'Fixed in v0.3' })).toEqual({ commented: true, url: 'https://github.com/octo/NOVI/issues/3#c1' });
    expect(JSON.parse(calls[0].body)).toEqual({ body: 'Fixed in v0.3' });
  });

  it('opening an issue needs approval with title and body', async () => {
    const { host, calls } = await setup({ routes: [{ method: 'POST', match: /\/repos\/octo\/NOVI\/issues$/, reply: { number: 9, html_url: 'https://github.com/octo/NOVI/issues/9' } }] });
    const tool = host.get('github_create_issue');
    expect(await tool.gate({ repo: 'NOVI', title: 'TV casting', body: 'Show progress on the TV' })).toEqual({ approval: { title: 'Open an issue on octo/NOVI as octo: TV casting', detail: 'Show progress on the TV', tier: 'medium' } });
    expect(await tool.run({ repo: 'NOVI', title: 'TV casting', body: 'Show progress on the TV' })).toEqual({ created: 9, url: 'https://github.com/octo/NOVI/issues/9' });
    expect(JSON.parse(calls[0].body)).toEqual({ title: 'TV casting', body: 'Show progress on the TV' });
  });

  it('marking notifications read needs approval', async () => {
    const { host, calls } = await setup({ routes: [{ method: 'PUT', match: /\/notifications$/, reply: { status: 205 } }] });
    const tool = host.get('github_mark_read');
    expect((await tool.gate({})).approval).toMatchObject({ title: 'Mark all GitHub notifications as read (octo)', tier: 'medium' });
    expect(await tool.run({})).toEqual({ marked: 'all' });
    expect(calls[0].method).toBe('PUT');
  });

  it('write tools block (no approval) when the account is unclear', async () => {
    const { host } = await setup({ logins: ['octo', 'work-bot'] });
    const gate = await host.get('github_comment').gate({ repo: 'NOVI', number: 1, body: 'hi' });
    expect(gate.block).toBe(true);
    expect(gate.details.ask).toHaveLength(2);
  });

  it('a revoked token marks the account expired and asks to reconnect', async () => {
    const { host, accounts } = await setup({ routes: [{ match: /\/notifications\?/, reply: { status: 401, body: { message: 'Bad credentials' } } }] });
    await expect(host.get('github_notifications').run({})).rejects.toThrow(/connect my GitHub/);
    expect(accounts.list('github')[0].status).toBe('expired');
  });

  it('explains missing repos', async () => {
    const { host } = await setup({ routes: [{ match: /\/repos\/octo\/nope$/, reply: { status: 404, body: { message: 'Not Found' } } }] });
    await expect(host.get('github_issues').run({ repo: 'nope' })).rejects.toThrow(/couldn't find octo\/nope/);
  });
});

describe('pollForToken', () => {
  const poll = (reply) => pollForToken({ clientId: 'c', deviceCode: 'd', interval: 0, expiresIn: 60, sleep: async () => {}, fetchImpl: async () => new Response(JSON.stringify(reply)) });
  it('reports cancel and expiry clearly', async () => {
    await expect(poll({ error: 'access_denied' })).rejects.toThrow(/cancelled/);
    await expect(poll({ error: 'expired_token' })).rejects.toThrow(/expired/);
  });
});
