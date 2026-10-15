import { definePluginEntry } from '#plugin-sdk';

// Web search and page reading on free keys (.env, read here because the host only passes
// NOVI_PLUGIN_WEB_* to plugins): Tavily search first (TAVILY_API_KEYS, 1,000 a month), Jina search
// as backup (JINA_API_KEYS, one-time token grant); Jina Reader reads pages without a key and uses
// the key only when the free reader is rate-limited. Each key goes only to its own service.
const TAVILY_URL = 'https://api.tavily.com/search';
const JINA_SEARCH_URL = 'https://s.jina.ai/';
const JINA_READ_URL = 'https://r.jina.ai/';
const MAX_TEXT = 8_000; // ≈2k tokens for the AI
const TIMEOUT_MS = 20_000;

const keysOf = (value) => String(value || '').split(',').map((k) => k.trim()).filter(Boolean);
const reply = (details) => ({ content: [{ type: 'text', text: details.error || details.answer || details.text || '' }], details });
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// "example.com" → https://example.com; anything that isn't an http(s) link → null.
function webLink(raw) {
  const s = String(raw || '').trim();
  if (!s || /^[a-z]:\\/i.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.href.endsWith('/') && !s.endsWith('/') ? u.href.slice(0, -1) : u.href; // keep "example.com" as typed
  } catch { return null; }
}

export function createWebPlugin({ env = process.env, fetchImpl = fetch } = {}) {
  const tavilyKeys = keysOf(env.TAVILY_API_KEYS);
  const jinaKeys = keysOf(env.JINA_API_KEYS);

  async function call(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`${host(url)} answered ${res.status}`), { status: res.status });
    return res.json();
  }

  async function tavily(query, max) {
    let last;
    for (const key of tavilyKeys) {
      try {
        const body = await call(TAVILY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: max, search_depth: 'basic', include_answer: true }),
        });
        return {
          answer: String(body.answer || '').trim() || null,
          results: (body.results || []).map((r) => ({ title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 400) })),
          via: 'tavily',
        };
      } catch (err) { last = err; }
    }
    throw last;
  }

  async function jinaSearch(query, max) {
    let last;
    for (const key of jinaKeys) {
      try {
        const body = await call(`${JINA_SEARCH_URL}?q=${encodeURIComponent(query)}`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'X-Respond-With': 'no-content' },
        });
        return { answer: null, results: (body.data || []).slice(0, max).map((r) => ({ title: r.title, url: r.url, snippet: String(r.description || '').slice(0, 400) })), via: 'jina' };
      } catch (err) { last = err; }
    }
    throw last;
  }

  return definePluginEntry({
    id: 'web',
    name: 'Web search',
    description: 'Search the web and read web pages (free Tavily / Jina keys).',
    register(api) {
      api.registerTool({
        name: 'web_search',
        description: 'Search the web for anything current or factual you are not sure of: news, scores, prices, releases, "latest", "who won", "search the web/Google for X". Never guess these. Answer in 1-2 sentences from the results; the sources are shown to the user.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, in a few words' } }, required: ['query'] },
        async execute(_id, { query } = {}) {
          const q = String(query || '').trim();
          if (!q) return reply({ error: 'What should I search for?' });
          if (!tavilyKeys.length && !jinaKeys.length) return reply({ error: 'Web search is not set up: add TAVILY_API_KEYS (free at app.tavily.com) to .env and restart Novi.' });
          const tries = [tavilyKeys.length && tavily, jinaKeys.length && jinaSearch].filter(Boolean);
          for (const search of tries) {
            try {
              const found = await search(q, 5);
              if (!found.results.length && !found.answer) continue;
              return reply({ query: q, ...found, sources: found.results.map(({ title, url }) => ({ title, url })) });
            } catch (err) {
              api.logger?.warn?.(`[web] ${search === tavily ? 'Tavily' : 'Jina'} search failed: ${err.message}`);
            }
          }
          return reply({ error: `I couldn't search the web right now. Try again in a minute.` });
        },
      });

      api.registerTool({
        name: 'web_read',
        description: 'Read one web page (a link the user gave or a search result) as plain text, to answer from it or summarize it.',
        parameters: { type: 'object', properties: { url: { type: 'string', description: 'The page link, e.g. https://example.com/article' } }, required: ['url'] },
        async execute(_id, { url } = {}) {
          const link = webLink(url);
          if (!link) return reply({ error: 'That is not a web link (it must start with http:// or https://).' });
          const headers = { Accept: 'application/json', 'X-Return-Format': 'markdown', 'X-Retain-Images': 'none', 'X-Timeout': '15' };
          let last;
          for (const key of [null, ...jinaKeys]) {
            try {
              const body = await call(`${JINA_READ_URL}${link}`, { headers: key ? { ...headers, Authorization: `Bearer ${key}` } : headers });
              const page = body.data || {};
              const text = String(page.content || '').trim();
              return reply({ title: page.title || host(link), url: page.url || link, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(cut)` : text });
            } catch (err) {
              last = err;
              if (![401, 402, 403, 429].includes(err.status)) break; // only a limit is worth the key
            }
          }
          api.logger?.warn?.(`[web] read failed: ${last?.message}`);
          return reply({ error: `I couldn't read ${host(link) || 'that page'} right now.` });
        },
      });
    },
  });
}

export default createWebPlugin();
