// What Novi types into each AI website. Fixed headings, so the brief can be put together without AI.
const about = ({ project, request, facts }) => `What I want: ${request}\nProject: ${project || 'a new project'}\n\nWhat's there now:\n${facts}`;

export const PLAN_HEADINGS = ['Goal', 'Steps', 'Look & feel', 'Done when'];
export const IDEAS_HEADINGS = ['Examples', 'Security rules'];

// ChatGPT: the plan Claude Code will follow.
export function planPrompt(job) {
  return `I'm planning a coding job that Claude Code (an AI coding agent) will build. Write the plan it should follow.

${about(job)}

Answer with exactly these headings, in this order:
## Goal
(1-2 sentences)
## Steps
(numbered, at most 8, one line each, in build order)
## Look & feel
(layout, colours, fonts, mobile; short bullets)
## Done when
(3-5 checkable bullets)
No code. Under 400 words.`;
}

// Gemini: examples to learn from and security rules (user's choice, 2026-10-18).
export function ideasPrompt(job) {
  return `I'm about to build this with an AI coding agent and want ideas and safety rules first.

${about(job)}

Answer with exactly these headings:
## Examples
(3-5 real websites or apps like this: name, link, what to borrow; one line each. Never make up a link: if you are not sure of the exact address, give the site's home page or no link at all)
## Security rules
(5-8 short rules for this kind of project: forms, secrets, user input, dependencies…)
No code. Under 300 words.`;
}

// "Change X" goes back to the same ChatGPT chat.
export const changePrompt = (change) => `Change the plan: ${change}\nAnswer again with the same headings: Goal, Steps, Look & feel, Done when.`;

// A new project with no name said ("let's build a tiny tip calculator app") is named from the words
// (first live run 2026-10-20: it was briefed as "New project").
const KIND = /\s+(?:web\s*app|website|web\s*site|site|app|application|project|tool|page)$/i;
export function projectNameFrom(request) {
  const t = String(request || '').trim().replace(/[.!?]+$/, '')
    .replace(/^(?:(?:ok(?:ay)?|hey novi|novi|so|please)[, ]+)*/i, '')
    .replace(/^(?:let'?s|let us|can you|could you|please|i want to|we should|i'd like to)\s+/i, '');
  const m = /^(?:build|make|create|start|design|code|develop)\s+(?:me\s+|us\s+)?(?:(?:a|an|the|my|our)\s+)?(.+)$/i.exec(t);
  if (!m) return null;
  let rest = m[1].replace(/^(?:(?:tiny|small|simple|quick|basic|new|little|cool|nice)\s+)+/i, '').trim();
  const forWhat = /^(web\s*app|website|web\s*site|site|app|application|page)\s+for\s+(?:(?:my|a|an|the|our)\s+)?(.+)$/i.exec(rest);
  if (forWhat) rest = `${forWhat[2]} ${/app|application/i.test(forWhat[1]) ? 'app' : 'website'}`;
  else rest = rest.replace(KIND, '').trim();
  if (rest.replace(/[^\p{L}]/gu, '').length < 3) return null;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

