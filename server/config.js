import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDERS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    // Each Groq model has its own free rate limit, so a third model adds capacity (models checked 2026-10-07).
    fast: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    long: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    // Simple questions: the small model with low reasoning answers in ~0.6-1 s (llama-3.1-8b-instant was retired).
    quick: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fast: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
    long: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
  },
  // Free backup (200k tokens/day per model). Not a private provider: personal turns stay on Groq.
  sambanova: {
    baseURL: 'https://api.sambanova.ai/v1',
    fast: ['Meta-Llama-3.3-70B-Instruct', 'Llama-4-Maverick-17B-128E-Instruct'],
    long: ['Meta-Llama-3.3-70B-Instruct', 'Llama-4-Maverick-17B-128E-Instruct'],
    quick: ['Meta-Llama-3.1-8B-Instruct', 'Meta-Llama-3.3-70B-Instruct'],
  },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', fast: [], long: [] },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', fast: [], long: [] },
  mistral: { baseURL: 'https://api.mistral.ai/v1', fast: [], long: [] },
};

const DEFAULT_FAST = ['groq', 'gemini', 'sambanova', 'cerebras', 'openrouter', 'mistral'];
// Groq first for both: measured ~0.5s vs Gemini 12-30s for tool-calling turns (2026-10-02).
const DEFAULT_LONG = ['groq', 'gemini', 'sambanova', 'cerebras', 'openrouter', 'mistral'];

export function splitList(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const providers = [];
  for (const [name, def] of Object.entries(PROVIDERS)) {
    const upper = name.toUpperCase();
    const keys = splitList(env[`${upper}_API_KEYS`]);
    const override = splitList(env[`${upper}_MODELS`]);
    const models = override.length ? { fast: override, long: override, quick: override } : { fast: def.fast, long: def.long, quick: def.quick || def.fast };
    if (keys.length && models.fast.length) providers.push({ name, baseURL: def.baseURL, keys, models });
  }

  const names = providers.map((p) => p.name);
  const order = (value, fallback) => {
    const listed = splitList(value).filter((n) => names.includes(n));
    return [...listed, ...fallback.filter((n) => names.includes(n) && !listed.includes(n))];
  };

  const home = env.USERPROFILE || env.HOME || os.homedir();
  const localClaude = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');

  return {
    port: Number(env.NOVI_PORT || 3001),
    dataDir: path.resolve(env.NOVI_DATA_DIR || 'data'),
    providers,
    order: { fast: order(env.NOVI_FAST_ORDER, DEFAULT_FAST), long: order(env.NOVI_LONG_ORDER, DEFAULT_LONG), quick: order(env.NOVI_FAST_ORDER, DEFAULT_FAST) },
    claudeCommand: env.CLAUDE_PATH || (fs.existsSync(localClaude) ? localClaude : 'claude'),
    coder: env.NOVI_CODER === 'claude' ? 'claude' : 'free',
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    googleClientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
    privateProviders: splitList(env.NOVI_PRIVATE_PROVIDERS || 'groq'),
  };
}
