import { describe, it, expect } from 'vitest';
import { chatCompletion, ProviderError, parseRetryAfterMs } from '../../server/brain/openaiCompat.js';

const json = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers });
const args = { baseURL: 'https://x.test/v1', key: 'k1', model: 'm1', messages: [{ role: 'user', content: 'hi' }] };

async function errorOf(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected rejection');
}

describe('chatCompletion', () => {
  it('posts to /chat/completions with bearer key and tools, returns raw message', async () => {
    let seen;
    const message = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }] };
    const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 }); };
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
    const result = await chatCompletion({ ...args, tools, fetchImpl });
    expect(seen.url).toBe('https://x.test/v1/chat/completions');
    expect(seen.init.headers.Authorization).toBe('Bearer k1');
    expect(JSON.parse(seen.init.body).tools).toEqual(tools);
    expect(result).toEqual(message);
  });

  it('omits tools when none are given', async () => {
    let body;
    const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })); };
    await chatCompletion({ ...args, fetchImpl });
    expect(body.tools).toBeUndefined();
  });

  it('classifies 429 with retry-after header', async () => {
    const err = await errorOf(chatCompletion({ ...args, fetchImpl: json(429, { error: { message: 'slow down' } }, { 'retry-after': '12' }) }));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12000);
  });

  it('reads Groq-style "try again in 7.5s"', async () => {
    const err = await errorOf(chatCompletion({ ...args, fetchImpl: json(429, { error: { message: 'Rate limit reached. Please try again in 7.5s.' } }) }));
    expect(err.retryAfterMs).toBe(7500);
  });

  it('handles Gemini array error bodies (503 → unavailable)', async () => {
    const err = await errorOf(chatCompletion({ ...args, fetchImpl: json(503, [{ error: { code: 503, message: 'high demand' } }]) }));
    expect(err.kind).toBe('unavailable');
    expect(err.message).toBe('high demand');
  });

  it('maps 404 → model_unavailable, 401 → auth, 400 → bad_request', async () => {
    expect((await errorOf(chatCompletion({ ...args, fetchImpl: json(404, [{ error: { message: 'gone' } }]) }))).kind).toBe('model_unavailable');
    expect((await errorOf(chatCompletion({ ...args, fetchImpl: json(401, { error: { message: 'bad key' } }) }))).kind).toBe('auth');
    expect((await errorOf(chatCompletion({ ...args, fetchImpl: json(400, { error: { message: 'bad' } }) }))).kind).toBe('bad_request');
  });

  it('maps thrown fetch errors → network', async () => {
    const err = await errorOf(chatCompletion({ ...args, fetchImpl: async () => { throw new Error('ECONNRESET'); } }));
    expect(err.kind).toBe('network');
  });
});

describe('parseRetryAfterMs', () => {
  it('defaults to 60s and understands ms', () => {
    expect(parseRetryAfterMs(new Headers(), 'nothing')).toBe(60000);
    expect(parseRetryAfterMs(new Headers(), 'try again in 250ms')).toBe(250);
  });
});

describe('reasoning effort', () => {
  it('sends reasoning_effort only to gpt-oss models when asked', async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 }); };
    await chatCompletion({ ...args, model: 'openai/gpt-oss-20b', reasoningEffort: 'low', fetchImpl });
    await chatCompletion({ ...args, model: 'gemini-flash-latest', reasoningEffort: 'low', fetchImpl });
    await chatCompletion({ ...args, model: 'openai/gpt-oss-120b', fetchImpl });
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(['low', undefined, undefined]);
  });
});
