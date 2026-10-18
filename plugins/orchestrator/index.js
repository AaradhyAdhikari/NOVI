import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { createSiteDriver } from './siteDriver.js';
import { gatherFacts } from './context.js';
import { planPrompt, ideasPrompt, changePrompt } from './prompts.js';
import { buildBrief } from './brief.js';

// Novi thinks before Claude codes (user, 2026-10-17/18): for a big job the ChatGPT website writes the
// plan and the Gemini website finds examples + security rules, in background Chrome tabs. A site that
// fails is answered by the free API for that part. The brief is saved in Novi Memory and shown as a
// card: yes → Claude starts on it, "change X" → back to ChatGPT, no → nothing.
// Spec: docs/superpowers/specs/2026-10-18-novi-orchestrator-design.md
const reply = (details) => ({ content: [], details });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const stamp = (d) => `${d.toLocaleDateString('en-CA')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const MAX_ROUNDS = 5;
const HOW = 'Say "yes" to send it to Claude ("yes, also …" to add something), "change …" to change the plan, or "no".';

export function createOrchestratorPlugin({ driver = null, track = () => {}, now = () => new Date() } = {}) {
  return definePluginEntry({
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'A brief from ChatGPT and Gemini before Claude starts a big coding job.',
    register(api) {
      const rt = api.runtime || {};
      const log = (m) => api.logger?.info?.(m);
      let sites = driver;
      const getSites = () => sites || (rt.browserRequest ? (sites = createSiteDriver({ request: rt.browserRequest, log })) : null);
      let busy = false;

      // One part of the brief: the website first, else the free API (prefer = that API's provider).
      async function part(key, prompt, source, prefer, connected) {
        const site = connected && getSites() ? await getSites().ask(key, prompt) : { error: "Chrome isn't connected" };
        if (site.text) return { text: site.text, source, site: true };
        try {
          const text = await rt.complete?.(prompt, { prefer });
          if (text) return { text, source: 'the backup AI', why: sentence(site.error) };
        } catch (err) { log(`[orchestrator] backup for ${source} failed: ${err.message}`); }
        return { error: site.error };
      }

      async function job({ project, name, request, isNew }) {
        const known = !isNew && project ? rt.codingProject?.(project) : null;
        // The folder's own capitals ("Portfolio brief"), so the brief sits next to "Portfolio project".
        const title = (known?.path && path.basename(known.path)) || known?.name || name || project || 'New project';
        const facts = gatherFacts(known?.path, { note: rt.wikiRead?.(`${title} brief`) });
        const work = { project: known?.name || title, request, facts };
        const connected = Boolean(rt.browserStatus?.().connected);
        const planP = planPrompt(work);
        let [plan, ideas] = await Promise.all([
          part('chatgpt', planP, 'ChatGPT', 'githubmodels', connected),
          part('gemini', ideasPrompt(work), 'Gemini', 'gemini', connected),
        ]);
        if (!plan.text && !ideas.text) {
          rt.say?.(`I couldn't reach ChatGPT or Gemini (${plan.error}). Say "tell Claude to …" to start without a brief.`, { kind: null });
          return;
        }
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const brief = buildBrief({ project: title, request, plan, ideas });
          rt.wikiWrite?.({ title: `${title} brief`, text: brief.text.replace(/^# Brief: .*$/m, `## ${stamp(now())}`) });
          const d = await rt.ask({ title: 'Send this brief to Claude?', detail: `${brief.text}\n\n${HOW}`, prompt: brief.spoken, changeable: true, addable: true, source: 'orchestrator' });
          if (d.allow) {
            const instruction = `${request}\n\nFollow this brief (made by Novi with ChatGPT and Gemini):\n\n${brief.text}${d.addition ? `\n\nAlso: ${d.addition}` : ''}`;
            const out = known ? await rt.startCoding({ project: known.name, instruction }) : await rt.newProject({ name: title, description: request, instruction });
            rt.say?.(out?.note || 'Claude is on it.', { kind: null });
            return;
          }
          if (!d.change) { rt.say?.("Okay, I won't send the brief.", { kind: null }); return; }
          // "Change X": the same ChatGPT chat, else the backup AI with the plan so far.
          const changed = plan.site
            ? await getSites().followUp('chatgpt', changePrompt(d.change))
            : { text: await rt.complete?.(`${planP}\n\nThe plan so far:\n${plan.text || '(none)'}\n\n${changePrompt(d.change)}`, { prefer: 'githubmodels' }).catch(() => null) };
          if (changed?.text) plan = { ...plan, text: changed.text };
          else rt.say?.(`I couldn't change it (${changed?.error || 'no answer'}), so here's the brief as it was.`, { kind: null });
        }
      }

      api.registerTool({
        name: 'project_brief',
        description: 'Before a big coding job the user did not hand to Claude by name ("let\'s work on portfolio", "make a new project for…"): ask ChatGPT and Gemini for a plan, examples and security rules, then show the brief for a yes. Runs in the background.',
        parameters: obj({
          project: str('Known project name (omit for a new project)'),
          name: str('New project name, if the user said one'),
          request: str("The user's words"),
          isNew: { type: 'boolean', description: 'true for a new project' },
        }, ['request']),
        async execute(_id, params = {}) {
          if (busy) return reply({ note: "I'm already making a brief. I'll show it as soon as it's ready." });
          busy = true;
          track(job(params).catch((err) => { log(`[orchestrator] ${err.message}`); rt.say?.(`The brief failed: ${err.message}`, { kind: null }); }).finally(() => { busy = false; }));
          return reply({ note: "Thinking it through with ChatGPT and Gemini… I'll show you the brief in about a minute." });
        },
      });
    },
  });
}

export default createOrchestratorPlugin();
