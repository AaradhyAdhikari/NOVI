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

// Edit selected text by voice: what each request asks of the model.
const EDITS = {
  shorter: 'Make the user\'s text shorter. Keep the meaning and the same language. Reply with only the new text.',
  bullets: 'Turn the user\'s text into short bullet points, one per line, each starting with "- ". Keep the same language. Reply with only the bullets.',
  formal: 'Rewrite the user\'s text in a formal, professional tone. Keep the meaning. Reply with only the new text.',
  casual: 'Rewrite the user\'s text in a casual, friendly tone. Keep the meaning. Reply with only the new text.',
  grammar: 'Fix the grammar and spelling in the user\'s text. Change nothing else. Reply with only the corrected text.',
};
const editPrompt = (how) => (String(how).startsWith('translate:')
  ? `Translate the user's text into ${String(how).slice(10)}. Reply with only the translation.`
  : EDITS[how]);
const NOTHING = '\u200bnovi-nothing-selected';
const MAX_EDIT = 1999; // laptop_clipboard read stops at 2000 characters; a cut-off selection must never be pasted back

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
      // Copy the selection, rewrite it, paste over it, put the old copy back. Anything odd changes nothing.
      const clip = (args) => api.runtime.callTool('laptop_clipboard', args);
      api.registerTool({
        name: 'text_edit_selection',
        description: 'Rewrite the text selected in the app in front with the AI on the laptop: how = shorter, bullets, formal, casual, grammar or translate:<language>.',
        parameters: { type: 'object', properties: { how: { type: 'string', description: 'shorter, bullets, formal, casual, grammar or translate:<language>' } }, required: ['how'] },
        async execute(_id, { how } = {}) {
          const fail = (error) => ({ content: [], details: { error } });
          const prompt = editPrompt(how);
          if (!prompt) return fail("I can't do that to selected text.");
          const before = (await clip({ do: 'read' })).text;
          const putBack = () => (before ? clip({ do: 'set', text: before }) : null);
          await clip({ do: 'set', text: NOTHING });
          await clip({ do: 'copy' });
          const seen = await clip({ do: 'read' });
          const text = seen.text;
          if (!text) { await putBack(); return fail("That looks like a password, so I won't change it."); }
          if (text === NOTHING) { await putBack(); return fail('Select the text first, then ask again.'); }
          if (text.length > MAX_EDIT) { await putBack(); return fail("That's too much text for the offline AI. Select a smaller part."); }
          let result = '';
          try { result = String(await llama.ask(prompt, text)).trim().replace(/^["“]+|["”]+$/g, '').trim(); } catch (err) { api.logger?.warn?.(`[rewrite] edit failed: ${err.message}`); }
          if (!result || CHATTY.test(result) || (how === 'shorter' && result.length >= text.length)) {
            await putBack();
            return fail("I couldn't rewrite that, so I left it as it was.");
          }
          await clip({ do: 'type', text: result });
          await putBack();
          return { content: [], details: { note: 'Rewrote it.' } };
        },
      });
      api.on('before_tool_call', ({ toolName, direct }) => (toolName === 'text_edit_selection' && !direct
        ? { requireApproval: { title: 'Rewrite the selected text', description: 'It replaces the text you selected.', severity: 'warning', category: 'screen', grantable: false } }
        : undefined));

      api.registerService({ id: 'rewrite-model', start() {}, stop() { llama.stop(); } });
    },
  });
}

export default createRewritePlugin();
