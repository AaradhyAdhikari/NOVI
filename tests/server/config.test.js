import { describe, it, expect } from 'vitest';
import { loadConfig, splitList } from '../../server/config.js';

describe('splitList', () => {
  it('trims and drops empties', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(splitList(undefined)).toEqual([]);
  });
});

describe('loadConfig', () => {
  const base = { GROQ_API_KEYS: 'g1, g2', GEMINI_API_KEYS: 'm1', USERPROFILE: 'C:\\nowhere' };

  it('loads groq and gemini with key pools and default models', () => {
    const c = loadConfig(base);
    expect(c.providers.map((p) => p.name)).toEqual(['groq', 'gemini']);
    expect(c.providers[0].keys).toEqual(['g1', 'g2']);
    expect(c.providers[0].models.fast[0]).toBe('openai/gpt-oss-120b');
    expect(c.providers[1].models.long).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest']);
  });

  it('skips providers without keys and extras without models', () => {
    const c = loadConfig({ GEMINI_API_KEYS: 'm1', CEREBRAS_API_KEYS: 'c1', USERPROFILE: 'C:\\nowhere' });
    expect(c.providers.map((p) => p.name)).toEqual(['gemini']);
  });

  it('enables an extra provider when models are given', () => {
    const c = loadConfig({ ...base, CEREBRAS_API_KEYS: 'c1', CEREBRAS_MODELS: 'llama-x' });
    expect(c.providers.find((p) => p.name === 'cerebras').models.fast).toEqual(['llama-x']);
  });

  it('orders providers: groq first for both (measured latency), env overrides', () => {
    expect(loadConfig(base).order).toEqual({ fast: ['groq', 'gemini'], long: ['groq', 'gemini'], quick: ['groq', 'gemini'] });
    expect(loadConfig({ ...base, NOVI_FAST_ORDER: 'gemini' }).order.fast).toEqual(['gemini', 'groq']);
  });

  it('has a quick lane on Groq (small model first) and a third Groq model as fallback', () => {
    // llama-3.1-8b-instant was retired by Groq (checked 2026-10-07); gpt-oss-20b with low reasoning is the quick model.
    expect(loadConfig(base).providers[0].models.quick).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(loadConfig(base).providers[0].models.fast).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  });

  it('adds SambaNova as a backup after Gemini when its key is set', () => {
    const c = loadConfig({ ...base, SAMBANOVA_API_KEYS: 's1' });
    const sn = c.providers.find((p) => p.name === 'sambanova');
    expect(sn.baseURL).toBe('https://api.sambanova.ai/v1');
    // Only gemma-4-31B-it works on a free SambaNova account (others answer 402 'payment method required', 2026-10-07).
    expect(sn.models).toEqual({ fast: ['gemma-4-31B-it'], long: ['gemma-4-31B-it'], quick: ['gemma-4-31B-it'] });
    expect(c.order.fast).toEqual(['groq', 'gemini', 'sambanova']);
  });

  it('uses CLAUDE_PATH when set, else falls back to "claude"', () => {
    expect(loadConfig({ ...base, CLAUDE_PATH: 'X:\\claude.exe' }).claudeCommand).toBe('X:\\claude.exe');
    expect(loadConfig(base).claudeCommand).toBe('claude');
  });

  it('defaults port 3001', () => {
    expect(loadConfig(base).port).toBe(3001);
  });

  it('reads Google OAuth credentials and private providers', () => {
    const c = loadConfig({ ...base, GOOGLE_CLIENT_ID: ' id.apps.googleusercontent.com ', GOOGLE_CLIENT_SECRET: 'GOCSPX-x' });
    expect(c.googleClientId).toBe('id.apps.googleusercontent.com');
    expect(c.googleClientSecret).toBe('GOCSPX-x');
    expect(c.privateProviders).toEqual(['groq']);
    expect(loadConfig({ ...base, NOVI_PRIVATE_PROVIDERS: 'groq,cerebras' }).privateProviders).toEqual(['groq', 'cerebras']);
    expect(loadConfig(base).googleClientId).toBe('');
  });

  it('defaults the coding agent to the free Novi Coder', () => {
    expect(loadConfig(base).coder).toBe('free');
    expect(loadConfig({ ...base, NOVI_CODER: 'claude' }).coder).toBe('claude');
    expect(loadConfig({ ...base, NOVI_CODER: 'whatever' }).coder).toBe('free');
  });
});
