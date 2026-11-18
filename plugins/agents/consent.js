// "May this kind of agent see this project?" asked once per project folder and remembered
// (data/agents/consent.json). Kinds: 'free' (free coding models, OpenCode) and 'browser-use' (the web
// worker). A yes to one is not a yes to the other. Older files keep their free-model answers under the bare
// folder key, so 'free' uses that key unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { consentKey } from './opencode.js';

const CARDS = {
  free: (p) => ({
    title: `Use free AI models on ${p}?`,
    prompt: `Free coding models may learn from ${p}'s code. Use them for the easy tasks on ${p}?`,
    detail: 'Free models (OpenCode: DeepSeek, GLM…) do the easy work so Claude\'s usage goes to the hard parts. Their providers may use what they see to improve their models. Your answer is remembered for this project.',
  }),
  'browser-use': (p) => ({
    title: `Let browser-use research the web for ${p}?`,
    prompt: `browser-use can look things up on the web for ${p}'s research steps. Allow it on ${p}?`,
    detail: 'It opens its own hidden browser (not your Chrome, none of your logins or files) and uses Novi\'s free AI keys (Groq, Gemini, GitHub Models), never Claude. The task it gets (the project\'s goal, finished work and decisions) goes to those AIs, and pages it visits see what it types. It cannot read or change files. Your answer is remembered for this project.',
  }),
};

// file: where answers live (null = remembered for this run only). ask(card) → { allow, closed, timedOut }.
// find(name) → { name, path } so answers are kept per folder (two projects called Foo are not one consent).
export function createConsent({ file = null, ask = null, find = () => null } = {}) {
  const answers = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
  const waiting = new Map(); // key → the card already waiting (one card per kind and project)
  const keyOf = (kind, project) => { const k = consentKey(find(project) || { name: project }); return kind === 'free' ? k : `${kind}:${k}`; };
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`); } catch { /* remembered for this run */ }
  };
  return {
    async ask(kind, project) {
      const k = keyOf(kind, project);
      if (k in answers) return answers[k];
      if (!ask || !CARDS[kind]) return false;
      if (!waiting.has(k)) {
        waiting.set(k, (async () => {
          const d = await ask({ ...CARDS[kind](project), source: 'agents' });
          if (d?.closed || d?.timedOut) return undefined; // not answered (not a no): asked again next time
          answers[k] = Boolean(d?.allow);
          save();
          return answers[k];
        })().finally(() => waiting.delete(k)));
      }
      return waiting.get(k);
    },
    // "Ask me again about browser-use on X": the stored answer goes, the next use asks again.
    forget(kind, project) {
      const k = keyOf(kind, project);
      if (k in answers) { delete answers[k]; save(); }
    },
  };
}
