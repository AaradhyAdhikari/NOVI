// Reads YouTube search results from the public results page (no API key).
// If YouTube changes the page, parsing returns [] and callers fall back to the search page.

export const searchUrl = (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

const textOf = (t) => t?.simpleText || t?.runs?.map((r) => r.text).join('') || '';

export function parseYouTubeResults(html, limit = 10) {
  const match = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }
  const results = [];
  (function walk(node) {
    if (!node || typeof node !== 'object' || results.length >= limit) return;
    if (node.videoRenderer?.videoId) {
      const v = node.videoRenderer;
      results.push({ position: results.length + 1, videoId: v.videoId, title: textOf(v.title), channel: textOf(v.ownerText), length: textOf(v.lengthText) || 'live' });
      return;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  })(data);
  return results;
}

export async function searchYouTube(query, { fetchImpl = fetch, limit = 10 } = {}) {
  const res = await fetchImpl(searchUrl(query), {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const results = parseYouTubeResults(await res.text(), limit);
  if (!results.length) throw new Error('Could not read YouTube results');
  return results;
}
