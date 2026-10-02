import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDERS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    fast: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    long: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    fast: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
    long: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-flash-lite-latest'],
  },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', fast: [], long: [] },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', fast: [], long: [] },
  mistral: { baseURL: 'https://api.mistral.ai/v1', fast: [], long: [] },
};

const DEFAULT_FAST = ['groq', 'gemini', 'cerebras', 'openrouter', 'mistral'];
const DEFAULT_LONG = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral'];

export function splitList(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const providers = [];
  for (const [name, def] of Object.entries(PROVIDERS)) {
    const upper = name.toUpperCase();
    const keys = splitList(env[`${upper}_API_KEYS`]);
    const override = splitList(env[`${upper}_MODELS`]);
    const models = override.length ? { fast: override, long: override } : { fast: def.fast, long: def.long };
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
    order: { fast: order(env.NOVI_FAST_ORDER, DEFAULT_FAST), long: order(env.NOVI_LONG_ORDER, DEFAULT_LONG) },
    claudeCommand: env.CLAUDE_PATH || (fs.existsSync(localClaude) ? localClaude : 'claude'),
    coder: env.NOVI_CODER === 'claude' ? 'claude' : 'free',
  };
}
