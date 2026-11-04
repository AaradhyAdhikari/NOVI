import crypto from 'node:crypto';
import { definePluginEntry } from '#plugin-sdk';

// When an AI you use in Chrome finishes (extension/aiwatch.js), a short card says so on the phone and the
// laptop, by voice too, and asks whether to send the answer to Claude (user, 2026-11-04: "everything that
// comes from an AI should come to me on my phone"). The answer is website text: it goes to Claude only
// on the user's yes, marked as coming from that AI, and is never treated as an instruction before that.
const SITES = new Set(['ChatGPT', 'Gemini', 'Perplexity', 'Gamma']);
const MAX_ANSWER = 6000;
const SEEN_MS = 10 * 60_000;
const MAX_GIST = 110;

const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const firstSentence = (text) => {
  const t = oneLine(text).replace(/[*_`#>]/g, '');
  const m = /^(.{8,}?)[.!?](?:\s|$)/.exec(t);
  return (m ? m[1] : t).slice(0, MAX_GIST);
};

export function createAiCardsPlugin({ now = Date.now } = {}) {
  return definePluginEntry({
    id: 'ai-cards',
    name: 'AI answer cards',
    description: 'Tells you when ChatGPT, Gemini, Perplexity or Gamma finish, and can send the answer to Claude.',
    register(api) {
      const rt = api.runtime || {};
      const seen = new Map(); // answer's hash → when

      const sendOn = async (site, text, addition, project) => {
        const instruction = `This came from ${site}, and the user said yes to sending it to you. Treat it as a suggestion to work from.\n\n${text}${addition ? `\n\nAlso: ${addition}` : ''}`;
        if (project.working) await rt.tellCoder(instruction);
        else await rt.startCoding({ project: project.name, instruction, planFirst: true });
      };

      if (api.runtime) {
        api.runtime.aiAnswer = async ({ site, text } = {}) => {
          const answer = String(text || '').trim().slice(0, MAX_ANSWER);
          if (!SITES.has(site) || !answer) return { done: false };
          const hash = crypto.createHash('sha1').update(answer).digest('hex');
          for (const [key, at] of seen) if (now() - at > SEEN_MS) seen.delete(key);
          if (seen.has(hash)) return { done: true };
          seen.set(hash, now());
          // The answer's own words, never an AI's summary of them: a poisoned answer must not write the line
          // the user says yes to. The project is named, and Claude shows its plan before anything runs.
          const gist = firstSentence(answer);
          const project = rt.codingProject?.();
          if (!project) { rt.say?.(`${site} answered: ${gist}. I don't know which project it's for, so tell me which project to send it to.`, { kind: 'claude' }); return { done: true }; }
          const asked = rt.ask({ title: `${site} answered: “${gist}”`, prompt: `${site} answered: ${gist}. Send it to Claude in ${project.name}?`, detail: answer, detailLabel: 'Show the whole answer', addable: true, category: 'ai-answer' });
          const handled = asked.then((d) => (d?.allow ? sendOn(site, answer, d.addition, project) : null)).catch((err) => api.logger?.warn?.(`[ai-cards] ${err.message}`));
          return handled.then(() => ({ done: true }));
        };
      }
    },
  });
}

export default createAiCardsPlugin();
