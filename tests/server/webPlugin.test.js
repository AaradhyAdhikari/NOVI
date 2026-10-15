import { describe, it, expect } from 'vitest';
import { PluginHost } from '../../server/plugins/host.js';
import { createWebPlugin } from '../../plugins/web/index.js';

const TAVILY = { answer: 'India won the match by 6 wickets.', results: [{ title: 'Match report', url: 'https://news.example/report', content: 'India chased 250…' }, { title: 'Scorecard', url: 'https://cricket.example/score', content: 'Full scores' }] };
const JINA_SEARCH = { code: 200, data: [{ title: 'From Jina', url: 'https://jina.example/a', description: 'A result' }] };
const JINA_READ = { code: 200, data: { title: 'Example Domain', url: 'https://example.com/', content: '# Example Domain\n\nThis domain is for examples.' } };

function setup({ env = { TAVILY_API_KEYS: 'tvly-1', JINA_API_KEYS: 'jina_1' }, answer = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {}, body: opts.body });
    const handler = Object.entries(answer).find(([prefix]) => u.startsWith(prefix))?.[1];
    if (handler) return handler({ url: u, headers: opts.headers || {}, body: opts.body });
    if (u.startsWith('https://api.tavily.com/search')) return Response.json(TAVILY);
    if (u.startsWith('https://s.jina.ai/')) return Response.json(JINA_SEARCH);
    if (u.startsWith('https://r.jina.ai/')) return Response.json(JINA_READ);
    throw new Error(`unexpected ${u}`);
  };
  const host = new PluginHost({ runtime: {}, env: {}, logger: { warn() {} } });
  expect(host.register(createWebPlugin({ env, fetchImpl }))).toBe(true);
  return { host, calls };
}

describe('web plugin: search (Tavily, then Jina)', () => {
  it('searches Tavily with the key and returns its answer plus sources', async () => {
    const { host, calls } = setup();
    const out = await host.get('web_search').run({ query: 'who won the india match' });
    expect(calls[0].url).toBe('https://api.tavily.com/search');
    expect(calls[0].headers.Authorization).toBe('Bearer tvly-1');
    expect(JSON.parse(calls[0].body)).toMatchObject({ query: 'who won the india match', max_results: 5 });
    expect(out.answer).toBe('India won the match by 6 wickets.');
    expect(out.sources).toEqual([{ title: 'Match report', url: 'https://news.example/report' }, { title: 'Scorecard', url: 'https://cricket.example/score' }]);
    expect(out.results[0].snippet).toContain('India chased');
  });

  it('falls back to Jina search when Tavily fails or has no key', async () => {
    const failing = setup({ answer: { 'https://api.tavily.com': () => new Response('limit', { status: 432 }) } });
    const out = await failing.host.get('web_search').run({ query: 'x' });
    expect(out.sources).toEqual([{ title: 'From Jina', url: 'https://jina.example/a' }]);
    const jina = failing.calls.find((c) => c.url.startsWith('https://s.jina.ai/'));
    expect(jina.url).toBe('https://s.jina.ai/?q=x');
    expect(jina.headers.Authorization).toBe('Bearer jina_1');

    const noTavily = setup({ env: { JINA_API_KEYS: 'jina_1' } });
    expect((await noTavily.host.get('web_search').run({ query: 'x' })).sources[0].url).toBe('https://jina.example/a');
    expect(noTavily.calls.some((c) => c.url.includes('tavily'))).toBe(false);
  });

  it('a second Tavily key is tried when the first is used up', async () => {
    const { host, calls } = setup({ env: { TAVILY_API_KEYS: 'tvly-1, tvly-2' }, answer: { 'https://api.tavily.com': ({ headers }) => (headers.Authorization === 'Bearer tvly-1' ? new Response('', { status: 429 }) : Response.json(TAVILY)) } });
    expect((await host.get('web_search').run({ query: 'x' })).answer).toMatch(/India/);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tvly-1', 'Bearer tvly-2']);
  });

  it('says plainly when search is not set up or everything failed', async () => {
    const none = setup({ env: {} });
    expect((await none.host.get('web_search').run({ query: 'x' })).error).toMatch(/TAVILY_API_KEYS/);
    const down = setup({ answer: { 'https://api.tavily.com': () => new Response('', { status: 500 }), 'https://s.jina.ai': () => new Response('', { status: 500 }) } });
    expect((await down.host.get('web_search').run({ query: 'x' })).error).toMatch(/couldn't search the web/i);
  });

  it('never sends the keys anywhere but their own service', async () => {
    const { host, calls } = setup();
    await host.get('web_search').run({ query: 'x' });
    await host.get('web_read').run({ url: 'https://example.com' });
    for (const c of calls) {
      if (!c.url.startsWith('https://api.tavily.com')) expect(JSON.stringify(c.headers)).not.toContain('tvly-1');
    }
  });
});

describe('web plugin: read a page (Jina Reader)', () => {
  it('reads without the key first, as clean markdown with no images', async () => {
    const { host, calls } = setup();
    const out = await host.get('web_read').run({ url: 'https://example.com' });
    expect(calls[0].url).toBe('https://r.jina.ai/https://example.com');
    expect(calls[0].headers).toMatchObject({ Accept: 'application/json', 'X-Return-Format': 'markdown', 'X-Retain-Images': 'none' });
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(out).toMatchObject({ title: 'Example Domain', url: 'https://example.com/' });
    expect(out.text).toContain('This domain is for examples.');
  });

  it('uses the key only when the free reader is rate-limited', async () => {
    const { host, calls } = setup({ answer: { 'https://r.jina.ai': ({ headers }) => (headers.Authorization ? Response.json(JINA_READ) : new Response('', { status: 429 })) } });
    expect((await host.get('web_read').run({ url: 'example.com' })).title).toBe('Example Domain');
    expect(calls.map((c) => c.headers.Authorization)).toEqual([undefined, 'Bearer jina_1']);
    expect(calls[0].url).toBe('https://r.jina.ai/https://example.com');
    await host.get('web_read').run({ url: 'https://x.com/?a=1' });
    expect(calls.at(-1).url).toBe('https://r.jina.ai/https://x.com/?a=1');
  });

  it('cuts long pages and refuses anything that is not a web link', async () => {
    const long = setup({ answer: { 'https://r.jina.ai': () => Response.json({ data: { title: 'T', url: 'https://x.com', content: 'w '.repeat(20_000) } }) } });
    expect((await long.host.get('web_read').run({ url: 'https://x.com' })).text.length).toBeLessThanOrEqual(8_100);
    const { host, calls } = setup();
    for (const url of ['file:///C:/Users/a/.env', 'javascript:alert(1)', 'C:\\secret.txt', '']) {
      expect((await host.get('web_read').run({ url })).error, url).toMatch(/web link/i);
    }
    expect(calls).toEqual([]);
  });
});
