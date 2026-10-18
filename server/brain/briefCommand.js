// Big coding jobs where Claude isn't named get a brief first (orchestrator, user 2026-10-18):
// "let's work on portfolio", "let's build a todo app", "make a new project called X for Y",
// "build me a website for my cafe". Claude named, "skip the brief", small changes and things
// that aren't projects (folders, reminders, music…) never start one.
const NAMED = /\b(?:claude|novi coder)\b/i;
const SKIP = /\b(?:skip the brief|no brief|without (?:a|the) brief|just do it)\b/i;
const THING = /\b(?:project|app|application|website|site|web ?app|game|tool|bot|dashboard|extension|portfolio|clone|landing page|api)\b/i;
const LET = "(?:let'?s|lets|let us|chalo)";

export function briefCommand(text) {
  const request = String(text || '').trim().replace(/[.!?।]+$/, '');
  if (!request || NAMED.test(request) || SKIP.test(request)) return null;
  const t = request.replace(/^(?:(?:ok(?:ay)?|hey novi|novi|so|alright|please)[, ]+)+/i, '');
  const on = new RegExp(`^${LET}\\s+(?:work on|continue(?: with)?|start on|get back to)\\s+(?:my |the |our )?(.+)$`, 'i').exec(t);
  if (on) {
    const project = on[1].split(/\s+(?:project|app|site|website)\b|\s*,|\s+(?:and|to|today|now|for|with)\b/i)[0].trim();
    return project ? { project, request } : null;
  }
  const make = new RegExp(`^(?:${LET}\\s+)?(?:build|make|create|start)(?: me)?\\s+(?:a|an)\\s+(?:new\\s+)?(.+)$`, 'i').exec(t);
  if (!make || !THING.test(make[1])) return null;
  const name = /\b(?:called|named)\s+(.+?)(?:\s+(?:for|that|to|which|where|and|with)\b|$)/i.exec(make[1])?.[1]?.trim();
  return { isNew: true, ...(name ? { name } : {}), request };
}

// While the brief card waits: "change it to X", "instead X", "X instead" → X goes back to ChatGPT.
export function changeCommand(text) {
  const t = String(text || '').trim().replace(/[.!?।]+$/, '');
  const m = /^(?:no[, ]+)?(?:change|badlo|badal do)\s+(?:(?:it|that|this|the plan|the brief)\s+)?(?:(?:to|so that|so|into)\s+|[:,]\s*)?(.+)$/i.exec(t)
    || /^(?:no[, ]+)?instead[,:]?\s+(.+)$/i.exec(t)
    || /^(.+?)[, ]+instead$/i.exec(t);
  const what = m?.[1]?.trim();
  return what && !/^(?:it|that|this)$/i.test(what) ? what : null;
}
