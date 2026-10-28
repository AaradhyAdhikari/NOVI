// The done-check by voice, without the AI (plugins/donecheck): "check it", "is it done", "run the
// checks on X", "check my X project" → check the project's site against its brief; "fix it", "fix the
// failed ones", "theek karo" → send only the failed checks to Claude. The user's words are the yes.
// A project word (project / app / site) is needed after "check my X", so "check my email / notes /
// ChatGPT plan" stay with their own routes.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const KIND = '(?:project|app|site|website)';
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').trim();
const withProject = (tool, project) => ({ tool, args: project ? { project: name(project) } : {} });

export function doneCheckCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  let m;
  if ((m = /^(?:check it|is it (?:done|ready|working)(?: yet| now)?|(?:run|do) the checks?(?:\s+(?:on|for|of)\s+(.+?))?)$/i.exec(t))) return withProject('donecheck_run', m[1]);
  if ((m = new RegExp(`^(?:check|test)\\s+(?:my|the)\\s+(.+?)\\s+${KIND}$`, 'i').exec(t))) return withProject('donecheck_run', m[1]);
  if ((m = new RegExp(`^is\\s+(?:my|the)\\s+(.+?)\\s+${KIND}\\s+(?:done|ready|working)(?: yet| now)?$`, 'i').exec(t))) return withProject('donecheck_run', m[1]);
  if ((m = /^(?:fix it|fix (?:the |all the )?(?:failed|failing|broken) (?:ones|checks)(?:\s+(?:in|on|for|of)\s+(.+?))?|fix what failed|theek (?:karo|kar do)|sahi (?:karo|kar do))$/i.exec(t))) return withProject('donecheck_fix', m[1]);
  return null;
}
