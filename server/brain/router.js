import { chatCompletion, ProviderError } from './openaiCompat.js';

const FAILURES_BEFORE_UNHEALTHY = 3;
const UNHEALTHY_MS = 2 * 60_000;
const AUTH_DISABLE_MS = 60 * 60_000;

export class AllProvidersUnavailableError extends Error {
  constructor(retryInMs, lastError) {
    super(`All AI providers are unavailable${lastError ? `: ${lastError.message}` : ''}`);
    this.name = 'AllProvidersUnavailableError';
    this.retryInMs = retryInMs;
  }
}

export class Router {
  // local: the laptop's own model (server/localModel.js), the last resort. Used when every cloud AI is
  // offline or failing (not merely rate limited: those are waited out), or when the caller asks (local: true)
  // after its own waits. Never for the quick lane. Nothing leaves the laptop, so private turns may use it.
  constructor({ providers, order, call = chatCompletion, now = () => Date.now(), local = null }) {
    this.call = call;
    this.local = local;
    this.now = now;
    this.order = order;
    this.providers = new Map(
      providers.map((p) => [p.name, { ...p, cooldowns: new Map(), failures: 0, unhealthyUntil: 0, lastModel: null }]),
    );
  }

  _cooling(p, keyIndex, model) {
    const t = this.now();
    return (p.cooldowns.get(`auth#${keyIndex}`) || 0) > t || (p.cooldowns.get(`${model}#${keyIndex}`) || 0) > t;
  }

  // exclude: providers not to try (a turn moving off a busy provider).
  async chat({ messages, tools, purpose = 'fast', only, exclude = [], local = false }) {
    if (only === 'local') {
      try { return await this._local(messages, tools); } catch (err) { throw err instanceof AllProvidersUnavailableError ? err : new AllProvidersUnavailableError(30_000, err); }
    }
    const names = (only ? [only] : this.order[purpose] || this.order.fast).filter((n) => !exclude.includes(n));
    let lastError = null;
    let busy = false; // some provider is only rate limited: worth waiting out rather than the slow local model
    for (const name of names) {
      const p = this.providers.get(name);
      if (!p || p.unhealthyUntil > this.now()) continue;
      models: for (const model of p.models[purpose] || p.models.fast) {
        for (let i = 0; i < p.keys.length; i++) {
          if (this._cooling(p, i, model)) { if (!p.cooldowns.get(`auth#${i}`)) busy = true; continue; }
          try {
            const message = await this.call({ baseURL: p.baseURL, key: p.keys[i], model, messages, tools, reasoningEffort: purpose === 'quick' ? 'low' : undefined });
            p.failures = 0;
            p.lastModel = model;
            return { message, provider: name, model };
          } catch (err) {
            lastError = err;
            const kind = err instanceof ProviderError ? err.kind : 'unavailable';
            if (kind === 'rate_limit') {
              busy = true;
              p.cooldowns.set(`${model}#${i}`, this.now() + err.retryAfterMs);
              continue;
            }
            if (kind === 'auth') {
              p.cooldowns.set(`auth#${i}`, this.now() + AUTH_DISABLE_MS);
              continue;
            }
            if (kind === 'unavailable' || kind === 'network') {
              p.failures += 1;
              if (p.failures >= FAILURES_BEFORE_UNHEALTHY) {
                p.unhealthyUntil = this.now() + UNHEALTHY_MS;
                p.failures = 0;
                break models;
              }
            }
            continue models; // model_unavailable, bad_request, unavailable, network → next model
          }
        }
      }
    }
    if (this.local && purpose !== 'quick' && !exclude.includes('local') && (local || !busy)) {
      try { return await this._local(messages, tools); } catch (err) { lastError = err; }
    }
    throw new AllProvidersUnavailableError(this._soonestRetryMs(names), lastError);
  }

  async _local(messages, tools) {
    if (!this.local) throw new AllProvidersUnavailableError(30_000, new Error('No local model.'));
    const message = await this.local.chat({ messages, tools });
    return { message, provider: 'local', model: this.local.status?.().model || 'local' };
  }

  _soonestRetryMs(names) {
    const t = this.now();
    let best = Infinity;
    for (const name of names) {
      const p = this.providers.get(name);
      if (!p) continue;
      if (p.unhealthyUntil > t) best = Math.min(best, p.unhealthyUntil - t);
      for (const until of p.cooldowns.values()) if (until > t) best = Math.min(best, until - t);
    }
    return Number.isFinite(best) ? best : 30_000;
  }

  status() {
    const t = this.now();
    return [...this.providers.values()].map((p) => ({
      name: p.name,
      keys: p.keys.length,
      healthy: p.unhealthyUntil <= t,
      coolingKeys: [...p.cooldowns.values()].filter((until) => until > t).length,
      lastModel: p.lastModel,
    })).concat(this.local ? [{ name: 'local', keys: 0, local: true, healthy: true, coolingKeys: 0, ...(this.local.status?.() || {}) }] : []);
  }
}
