// Roles, not agents (multi-agent orchestrator Phase 3, 2026-11-11). User: "don't make Novi a rule-based
// router, make it a gap-aware router… agents may change but the flow should update itself". A task names a
// ROLE; any agent on the team that fills the role does the same job from the same package. The user's
// own agent words ("code it in Codex", "don't use ChatGPT, use Perplexity or DeepSeek") always win.
import { closestName } from '../../server/voice/soundAlike.js';

export const ROLES = ['research', 'plan', 'build', 'review'];
const VERB = { research: 'research', plan: 'plan', build: 'build', review: 'review' };
export const roleVerb = (role) => VERB[role] || role;
export const squashId = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

const ROLE_WORDS = [
  ['research', /\b(?:research|look up|find (?:out|examples|similar)|compare|survey|investigate|sources?)\b/i],
  ['review', /\b(?:security|audit|review|cross-?check|threat|vulnerab)/i],
  ['plan', /\b(?:spec|specification|plan|user flows?|ux|wireframe|copy|requirements|outline|break (?:it )?down)\b/i],
];
// A step that starts with a building verb builds, whatever words follow ("Add security headers" is code,
// not a review; code review 2026-11-11).
const BUILD_START = /^\s*(?:\d+[.)]\s*)?(?:add|implement|build|create|make|fix|write|wire|set up|refactor|update|change|remove|migrate|style|connect|install|configure)\b/i;
const ROLE_START = /^\s*(?:\d+[.)]\s*)?(?:research|review|audit|compare|investigate|look up|survey)\b/i;
const PLAN_NOUNS = /\b(?:spec|specification|requirements|wireframes?|user flows?|outline|(?:a|the) plan)\b/i; // "write the spec" plans; "build the pricing plan page" builds
export function roleFor(step) {
  const s = String(step || '');
  if (ROLE_START.test(s)) return /^\s*(?:\d+[.)]\s*)?(?:review|audit)/i.test(s) ? 'review' : 'research';
  if (/\btests?\b/i.test(s)) return 'build';
  if (BUILD_START.test(s) && !PLAN_NOUNS.test(s)) return 'build';
  for (const [role, re] of ROLE_WORDS) if (re.test(s)) return role;
  return 'build';
}

// How hard a build step is (2026-11-12): easy = small, local, visual; hard = security, money, data, many
// places at once; everything else medium. The track record does the rest.
export const LEVELS = ['easy', 'medium', 'hard'];
const HARD = /\b(?:auth\w*|log ?in|sign ?(?:in|up)|password|security|secure|encrypt\w*|payment\w*|checkout|billing|database|migrat\w*|schema|deploy\w*|architect\w*|refactor\w*|across|whole app|real-?time|websocket|concurren\w*|performance|scal\w*|api key|token)\b/i;
const EASY = /\b(?:typo|text|copy|wording|label|title|colou?r|font|spacing|margin|padding|icon|rename|readme|comment|small|tweak|button text|placeholder|blue|red|green|bold|align\w*|link text)\b/i;
export function levelFor(step) {
  const s = String(step || '');
  if (HARD.test(s)) return 'hard';
  if (EASY.test(s) && s.split(/\s+/).length <= 10) return 'easy';
  return 'medium';
}

const STOP = new Set('the a an it this that them my our your its me us him her one some any all for to of and or but so then now please'.split(' '));
const AVOID_BEFORE = /(?:don'?t|do not|never|without|not|no|avoid|skip|except|instead of)\s+(?:use\s+|using\s+|in\s+|on\s+|with\s+)?$/i;
const PREFER_BEFORE = /(?:use|using|with|via|through|in|on|to|prefer|ask|tell|let)\s+$/i;

// Who the user named, and how: prefer (use X / with X / X instead of Y), avoid (don't use X / without X /
// instead of X). A misheard name still counts (sound-alike); an unknown name after "use" is reported.
export function agentWords(text, names = []) {
  const ids = names.map((n) => ({ id: squashId(n), name: n }));
  const t = String(text || '').toLowerCase().replace(/[,.!?]+/g, ' , ');
  const words = t.split(/\s+/).filter(Boolean);
  const prefer = [];
  const avoid = [];
  const unknown = [];
  const push = (list, id) => { if (id && !list.includes(id)) list.push(id); };
  const idOf = (w) => {
    const exact = ids.find((n) => n.id === squashId(w));
    if (exact) return exact.id;
    const near = closestName(w, names, { min: 0.72, margin: 0.1 });
    return near ? squashId(near) : null;
  };
  let mode = null; // the last "use"/"don't use" seen: carries over "or"/"and"; a comma ends it
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const before = words.slice(Math.max(0, i - 3), i).join(' ') + ' ';
    if (w === ',') { mode = null; continue; }
    // Two-word names ("claude code", "backup ai") first; "the" before a name is skipped.
    let id = null;
    const two = words[i + 1] && words[i + 1] !== ',' ? ids.find((n) => n.id === squashId(`${w} ${words[i + 1]}`)) : null;
    if (two) { id = two.id; words.splice(i + 1, 1); } else if (w === 'the' && words[i + 1]) continue; else id = idOf(w);
    if (AVOID_BEFORE.test(before)) mode = 'avoid';
    else if (PREFER_BEFORE.test(before)) mode = 'prefer';
    else if (!['or', 'and'].includes(words[i - 1]) && words[i - 1] !== ',') mode = id ? mode : null;
    // "X instead of Y": X preferred, Y avoided.
    if (id && words[i + 1] === 'instead' && words[i + 2] === 'of') { push(prefer, id); mode = 'avoid'; continue; }
    if (id) {
      if (mode === 'avoid') push(avoid, id);
      else push(prefer, id);
      continue;
    }
    if (/^(?:use|using)$/.test(words[i - 1] || '') && !STOP.has(w) && !ids.some((n) => n.id === squashId(w))) unknown.push(w);
  }
  return { prefer: prefer.filter((p) => !avoid.includes(p)), avoid, unknown };
}
