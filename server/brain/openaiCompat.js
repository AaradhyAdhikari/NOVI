export class ProviderError extends Error {
  constructor(kind, message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function errorMessage(body) {
  const first = Array.isArray(body) ? body[0] : body;
  if (first?.error?.message) return first.error.message;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

export function parseRetryAfterMs(headers, message) {
  const header = headers?.get?.('retry-after');
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  const match = /(?:try again|retry) in ([\d.]+)\s*(ms|s)\b/i.exec(message || '');
  if (match) return Math.ceil(Number(match[1]) * (match[2].toLowerCase() === 'ms' ? 1 : 1000));
  return 60_000;
}

export function classifyHttpError(status, body, headers) {
  const message = errorMessage(body);
  if (status === 429) return new ProviderError('rate_limit', message, { status, retryAfterMs: parseRetryAfterMs(headers, message) });
  if (status === 401 || status === 403) return new ProviderError('auth', message, { status });
  if (status === 404) return new ProviderError('model_unavailable', message, { status });
  if (status >= 500) return new ProviderError('unavailable', message, { status });
  return new ProviderError('bad_request', message, { status });
}

export async function chatCompletion({ baseURL, key, model, messages, tools, reasoningEffort, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const body = { model, messages };
  // gpt-oss models think before answering; "low" makes simple replies much faster.
  if (reasoningEffort && /gpt-oss/.test(model)) body.reasoning_effort = reasoningEffort;
  if (tools?.length) body.tools = tools;
  let response;
  try {
    response = await fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError('network', err.message);
  }
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!response.ok) throw classifyHttpError(response.status, parsed, response.headers);
  const message = parsed?.choices?.[0]?.message;
  if (!message) throw new ProviderError('bad_request', 'Provider response had no message');
  return message;
}
