import crypto from 'node:crypto';
import { definePluginEntry } from '#plugin-sdk';

// When an AI you use in Chrome finishes (extension/aiwatch.js), a small card with one OK says so on the phone
// (user, 2026-11-04: "everything that comes from an AI should come to me on my phone"). Nothing goes to Claude
// unless the user says so (2026-11-06: "it should only send when i tell it … or else just report to me"): in
// their own prompt on that site, or afterwards ("send that to Claude in NOVI"). The project is always one they
// named, never the last one worked on: a Perplexity answer about NOVI was once offered to Tip calculator.
const SITES = new Set(['ChatGPT', 'Gemini', 'Perplexity', 'Gamma']);
const MAX_ANSWER = 6000;
const SEEN_MS = 10 * 60_000;
const MAX_GIST = 110;
const WHICH = 'Which project? Say: send that to Claude in, and the project.';

const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const firstSentence = (text) => {
  const t = oneLine(text).replace(/[*_`#>]/g, '');
  const m = /^(.{8,}?)[.!?](?:\s|$)/.exec(t);
  return (m ? m[1] : t).slice(0, MAX_GIST);
};

// The user's own words on the AI site, never the answer: an answer must not be able to send itself.
const SEND_ASKED = /\bsend(?:\s+(?:this|it|that|the answer))?\s+to\s+claude(?:\s+(?:in|on|for)\s+(?:my\s+|the\s+)?([^.!?,\n]+?))?(?:\s+project)?\s*(?:[.!?,\n]|$)/i;
export function sendAsked(asked) {
  const m = SEND_ASKED.exec(String(asked || ''));
  return m ? { project: m[1]?.trim() || null } : null;
}

const obj = (properties = {}) => ({ type: 'object', properties, additionalProperties: false });
const reply = (out) => ({ content: [{ type: 'text', text: JSON.stringify(out) }], details: out });

export function createAiCardsPlugin({ now = Date.now } = {}) {
  return definePluginEntry({
    id: 'ai-cards',
    name: 'AI answer cards',
    description: 'Tells you when ChatGPT, Gemini, Perplexity or Gamma finish, and sends an answer to Claude when you say so.',
    register(api) {
      const rt = api.runtime || {};
      const seen = new Map(); // answer's hash → when
      const lastBySite = new Map(); // lower-case site → { site, text }
      let newest = null;

      const sendOn = async ({ site, text }, project) => {
        const instruction = `This came from ${site}, and the user told Novi to send it to you. Treat it as a suggestion to work from.\n\n${text}`;
        if (project.working) await rt.tellCoder(instruction);
        else await rt.startCoding({ project: project.name, instruction, planFirst: true });
      };

      if (api.runtime) {
        api.runtime.aiAnswer = async ({ site, text, asked } = {}) => {
          const answer = String(text || '').trim().slice(0, MAX_ANSWER);
          if (!SITES.has(site) || !answer) return { done: false };
          const hash = crypto.createHash('sha1').update(answer).digest('hex');
          for (const [key, at] of seen) if (now() - at > SEEN_MS) seen.delete(key);
          if (seen.has(hash)) return { done: true };
          seen.set(hash, now());
          api.logger?.info?.(`[ai-cards] ${site} finished`); // never the words
          newest = { site, text: answer };
          lastBySite.set(site.toLowerCase(), newest);
          const card = { key: `ai-${site.toLowerCase()}`, title: `${site} finished`, spoken: `${site} finished.` };
          const told = sendAsked(asked);
          if (!told) { rt.notice?.({ ...card, body: firstSentence(answer) }); return { done: true }; }
          const project = told.project ? rt.codingProject?.(told.project) : null;
          if (!project) { rt.notice?.({ ...card, body: told.project ? `I don't know a project called ${told.project}. ${WHICH}` : WHICH }); return { done: true }; }
          await sendOn(newest, project).catch((err) => api.logger?.warn?.(`[ai-cards] ${err.message}`));
          rt.notice?.({ ...card, body: `Sent to Claude in ${project.name}.` });
          return { done: true };
        };

        api.runtime.aiSend = async ({ site, project } = {}) => {
          const answer = site ? lastBySite.get(String(site).toLowerCase()) : newest;
          if (!answer) return { note: `There's no AI answer to send${site ? ` from ${site}` : ''} yet.` };
          if (!project) return { note: WHICH };
          const p = rt.codingProject?.(project);
          if (!p) return { note: `I don't know a project called ${project}.` };
          await sendOn(answer, p);
          return { note: `Sent ${answer.site}'s answer to Claude in ${p.name}.` };
        };
      }

      api.registerTool({
        name: 'ai_answer_send',
        description: 'Send the last ChatGPT, Gemini, Perplexity or Gamma answer to Claude, only when the user asks ("send that to Claude in NOVI"). Needs the project the user named; never guess it.',
        parameters: obj({ project: { type: 'string' }, site: { type: 'string' } }),
        async execute(_id, args = {}) {
          return reply(await rt.aiSend(args));
        },
      });
    },
  });
}

export default createAiCardsPlugin();
