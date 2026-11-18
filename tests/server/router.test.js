import { describe, it, expect } from 'vitest';
import { Router, AllProvidersUnavailableError } from '../../server/brain/router.js';
import { ProviderError } from '../../server/brain/openaiCompat.js';

const providers = [
  { name: 'groq', baseURL: 'g', keys: ['g1', 'g2'], models: { fast: ['ga', 'gb'], long: ['ga'] } },
  { name: 'gemini', baseURL: 'm', keys: ['m1'], models: { fast: ['ma'], long: ['ml'] } },
];
const order = { fast: ['groq', 'gemini'], long: ['gemini', 'groq'] };

function setup(behaviour) {
  let t = 1_000_000;
  const calls = [];
  const call = async (req) => {
    calls.push(`${req.baseURL}:${req.model}:${req.key}`);
    const outcome = behaviour(req);
    if (outcome instanceof Error) throw outcome;
    return { role: 'assistant', content: `from ${req.model}` };
  };
  const router = new Router({ providers, order, call, now: () => t });
  return { router, calls, advance: (ms) => { t += ms; } };
}

const ok = () => null;
const rateLimited = (ms = 10_000) => new ProviderError('rate_limit', 'slow', { retryAfterMs: ms });
const unavailable = () => new ProviderError('unavailable', 'busy');

describe('Router', () => {
  it('uses the first fast provider, first model, first key', async () => {
    const { router, calls } = setup(ok);
    const res = await router.chat({ messages: [] });
    expect(res).toMatchObject({ provider: 'groq', model: 'ga' });
    expect(calls).toEqual(['g:ga:g1']);
  });

  it('long purpose prefers gemini long models', async () => {
    const { router } = setup(ok);
    expect(await router.chat({ messages: [], purpose: 'long' })).toMatchObject({ provider: 'gemini', model: 'ml' });
  });

  it('rate-limited key cools down; next key is used, then cooling key is skipped until expiry', async () => {
    const { router, calls, advance } = setup((r) => (r.key === 'g1' && calls.length === 1 ? rateLimited(10_000) : null));
    await router.chat({ messages: [] });
    expect(calls).toEqual(['g:ga:g1', 'g:ga:g2']);
    await router.chat({ messages: [] });
    expect(calls.at(-1)).toBe('g:ga:g2');
    advance(10_001);
    await router.chat({ messages: [] });
    expect(calls.at(-1)).toBe('g:ga:g1');
  });

  it('falls back to the next model on 503 and to the next provider when a provider is exhausted', async () => {
    const { router, calls } = setup((r) => (r.baseURL === 'g' ? (r.model === 'ga' ? unavailable() : rateLimited()) : null));
    const res = await router.chat({ messages: [] });
    expect(res.provider).toBe('gemini');
    expect(calls).toEqual(['g:ga:g1', 'g:gb:g1', 'g:gb:g2', 'm:ma:m1']);
  });

  it('marks a provider unhealthy after 3 unavailable failures for 2 minutes', async () => {
    const { router, calls, advance } = setup((r) => (r.baseURL === 'g' ? unavailable() : null));
    await router.chat({ messages: [] }); // ga, gb fail (2)
    await router.chat({ messages: [] }); // ga fails (3) → unhealthy
    const groqCalls = () => calls.filter((c) => c.startsWith('g:')).length;
    expect(groqCalls()).toBe(3);
    await router.chat({ messages: [] });
    expect(groqCalls()).toBe(3);
    expect(router.status().find((s) => s.name === 'groq').healthy).toBe(false);
    advance(2 * 60_000 + 1);
    await router.chat({ messages: [] });
    expect(groqCalls()).toBe(5); // recovered: tries ga and gb again
  });

  it('auth error disables the key for every model', async () => {
    const { router, calls } = setup((r) => (r.key === 'g1' ? new ProviderError('auth', 'bad key') : null));
    await router.chat({ messages: [] });
    await router.chat({ messages: [] });
    expect(calls).toEqual(['g:ga:g1', 'g:ga:g2', 'g:ga:g2']);
  });

  it('`only` restricts to one provider', async () => {
    const { router } = setup(ok);
    expect((await router.chat({ messages: [], only: 'gemini' })).provider).toBe('gemini');
  });

  it('throws AllProvidersUnavailableError with the soonest retry time', async () => {
    const { router } = setup(() => rateLimited(5_000));
    const err = await router.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersUnavailableError);
    expect(err.retryInMs).toBe(5_000);
  });
});

describe('quick lane', () => {
  it('asks gpt-oss models for low reasoning on quick turns only', async () => {
    const seen = [];
    const providers = [{ name: 'groq', baseURL: 'g', keys: ['k'], models: { fast: ['openai/gpt-oss-120b'], quick: ['openai/gpt-oss-20b'] } }];
    const router = new Router({ providers, order: { fast: ['groq'], quick: ['groq'] }, call: async (req) => { seen.push(req); return { role: 'assistant', content: 'ok' }; } });
    await router.chat({ messages: [], purpose: 'quick' });
    await router.chat({ messages: [], purpose: 'fast' });
    expect(seen.map((r) => [r.model, r.reasoningEffort])).toEqual([['openai/gpt-oss-20b', 'low'], ['openai/gpt-oss-120b', undefined]]);
  });
});

describe('skipping providers', () => {
  it('exclude: the named providers are not tried', async () => {
    const { router, calls } = setup(ok);
    expect(await router.chat({ messages: [], exclude: ['groq'] })).toMatchObject({ provider: 'gemini' });
    expect(calls).toEqual(['m:ma:m1']);
  });
});

describe('Router local fallback', () => {
  const offline = () => new ProviderError('network', 'fetch failed');
  function withLocal(behaviour, { fails = false } = {}) {
    const s = setup(behaviour);
    const asked = [];
    s.router.local = { chat: async (req) => { asked.push(req); if (fails) throw new Error('no memory'); return { role: 'assistant', content: 'offline answer' }; } };
    return { ...s, asked };
  }

  it('answers on the laptop when every cloud AI is offline', async () => {
    const s = withLocal(offline);
    const res = await s.router.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res).toMatchObject({ provider: 'local', message: { content: 'offline answer' } });
  });

  it('waits out a rate limit instead of using the slow local model', async () => {
    const s = withLocal(() => rateLimited(1000));
    await expect(s.router.chat({ messages: [] })).rejects.toBeInstanceOf(AllProvidersUnavailableError);
    expect(s.asked).toEqual([]);
  });

  it('uses it for a busy turn only when asked (local: true)', async () => {
    const s = withLocal(() => rateLimited(1000));
    expect(await s.router.chat({ messages: [], local: true })).toMatchObject({ provider: 'local' });
  });

  it('never in the quick lane', async () => {
    const s = withLocal(offline);
    await expect(s.router.chat({ messages: [], purpose: 'quick', local: true })).rejects.toBeInstanceOf(AllProvidersUnavailableError);
  });

  it('a private turn (only) still falls back to the laptop', async () => {
    const s = withLocal(offline);
    expect(await s.router.chat({ messages: [], only: 'groq' })).toMatchObject({ provider: 'local' });
  });

  it('only: local goes straight to it', async () => {
    const s = withLocal(ok);
    expect(await s.router.chat({ messages: [], only: 'local' })).toMatchObject({ provider: 'local' });
    expect(s.calls).toEqual([]);
  });

  it('a local failure still throws the usual busy error', async () => {
    const s = withLocal(offline, { fails: true });
    await expect(s.router.chat({ messages: [] })).rejects.toBeInstanceOf(AllProvidersUnavailableError);
  });

  it('status lists the local model', async () => {
    const s = withLocal(ok);
    s.router.local.status = () => ({ state: 'asleep', model: 'm.gguf' });
    expect(s.router.status().find((p) => p.name === 'local')).toMatchObject({ name: 'local', local: true, state: 'asleep' });
  });
});
