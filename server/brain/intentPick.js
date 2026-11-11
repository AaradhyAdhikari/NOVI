import { ALWAYS } from './toolSelect.js';

// Smart routing (user, 2026-11-10: "it doesn't even think on its own when a new question or problem arises").
// The keyword picker (toolSelect.js) shows the AI only the tools whose words appear in the request; said a new
// way, the AI saw just the five basics and couldn't act. Then this quick step (the fast free model) reads one
// line per ability and picks up to 4, which the main AI gets on top. Rules stay as the fast lane.
const MAX = 4;

const firstSentence = (text) => String(text || '').split(/(?<=[.!?])\s/)[0].trim().slice(0, 90);

export function catalogLines(schemas) {
  return schemas.map((s) => `${s.function.name}: ${firstSentence(s.function.description)}`).join('\n');
}

// The keywords found nothing beyond the always-on basics, and the request has a few words to go on.
export function needsPick(offered, text) {
  if (String(text || '').trim().split(/\s+/).length < 3) return false;
  return offered.every((s) => ALWAYS.has(s.function.name));
}

// The quick AI's reply → { tools: known names (≤ 4, no repeats), ask: a clarifying question or null }.
export function parsePick(content, known) {
  const none = { tools: [], ask: null };
  const json = /\{[\s\S]*\}/.exec(String(content || ''))?.[0];
  if (!json) return none;
  let data;
  try { data = JSON.parse(json); } catch { return none; }
  const tools = [...new Set((Array.isArray(data.tools) ? data.tools : []).map(String))].filter((n) => known.has(n)).slice(0, MAX);
  const ask = typeof data.ask === 'string' && data.ask.trim() ? data.ask.trim().slice(0, 200) : null;
  return { tools, ask };
}

const PROMPT = `You route a request for Novi, a voice assistant on the user's Windows laptop, to the abilities that can do it.
Reply with JSON only: {"tools": [up to 4 exact names from the list], "ask": null}.
If it is only chat or a question you can answer from general knowledge, use "tools": [].
If you truly cannot tell what they want, use "ask": "one short question".
Abilities:
`;

export async function pickTools({ router, text, schemas }) {
  const known = new Set(schemas.map((s) => s.function.name));
  try {
    const res = await router.chat({ purpose: 'quick', messages: [{ role: 'system', content: PROMPT + catalogLines(schemas) }, { role: 'user', content: String(text) }] });
    return parsePick(res?.message?.content, known);
  } catch {
    return { tools: [], ask: null }; // the quick step failing never blocks the main answer
  }
}
