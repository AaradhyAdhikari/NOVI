import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from '#plugin-sdk';
import { createLlama } from './llama.js';

// Offline rewrite (checklist row "AI rewrite cleanup, offline"): a small model on the laptop polishes
// dictated words. It may only make them better: a failure, a slow answer or anything that doesn't
// look like the same words gives the user's own words back.
const MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models', 'llm', 'qwen2.5-1.5b-instruct-q4_k_m.gguf');
const POLISH = "Rewrite the user's dictated text so it reads cleanly: fix grammar and punctuation, drop filler words. Keep the meaning, the person and the same language. Never answer it or add anything. Reply with only the rewritten text.";
const CHATTY = /^(?:sure|okay|ok|here(?:'s| is)|certainly|rewritten|the rewritten)\b/i;

const FILLER = new Set(['um', 'uh', 'so', 'like', 'basically', 'actually', 'you', 'know', 'i', 'mean', 'well', 'just']);
const wordsOf = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

// Most of what was said must still be there (a small model "translated" Hinglish into a new sentence).
function keptWords(said, out) {
  const left = new Set(wordsOf(out));
  const mine = wordsOf(said).filter((w) => !FILLER.has(w));
  return !mine.length || mine.filter((w) => left.has(w)).length / mine.length >= 0.6;
}

export function safeRewrite(said, result) {
  const out = String(result || '').trim().replace(/^["'“]+|["'”]+$/g, '').trim();
  if (!out || CHATTY.test(out)) return said;
  const ratio = out.length / String(said).length;
  return ratio < 0.4 || ratio > 1.5 || !keptWords(said, out) ? said : out;
}

// Mostly another script: left alone, the small model turns it into English.
const notLatin = (text) => (String(text).match(/[^\x00-ɏ\s\p{P}\p{N}]/gu) || []).length > String(text).length * 0.3;

export function createRewritePlugin({ llama = createLlama({ model: MODEL }) } = {}) {
  return definePluginEntry({
    id: 'rewrite',
    name: 'Offline rewrite',
    description: 'Polishes dictated words with a small AI model on the laptop.',
    register(api) {
      api.registerTool({
        name: 'text_rewrite',
        description: 'Polish dictated text with the small AI model on the laptop (grammar, punctuation, fillers). Gives the same words back if it cannot.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'The words to polish' }, warm: { type: 'boolean', description: 'Only load the model' } } },
        async execute(_id, { text, warm } = {}) {
          if (warm) {
            await llama.warm().catch(() => {});
            return { content: [], details: {} };
          }
          const said = String(text || '');
          if (!said.trim() || notLatin(said)) return { content: [], details: { text: said } };
          try {
            return { content: [], details: { text: safeRewrite(said, await llama.ask(POLISH, said)) } };
          } catch (err) {
            api.logger?.warn?.(`[rewrite] kept the words as said: ${err.message}`);
            return { content: [], details: { text: said } };
          }
        },
      });
      api.registerService({ id: 'rewrite-model', start() {}, stop() { llama.stop(); } });
    },
  });
}

export default createRewritePlugin();
