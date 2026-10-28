// What Claude changed and the project's tests, by voice without the AI (plugins/changes):
// "what did Claude change", "show me the changes (in App.jsx)", "what changed in X", "show me the diff",
// "run the tests (on X)", "did the tests pass", "test results". The user's words are the yes.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?(?:tell me\s+)?/i;
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:project|app|site|code)$/i, '').trim();
// "what changed in the news today" is not about a project.
const NOT_PROJECT = /\b(?:news|today|world|weather|market|price|stocks?|india|politics)\b/i;

export function changesCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  let m;
  if ((m = /^(?:what did (?:claude|novi|you) change|what(?: has| have)? changed|what are the changes|show (?:me )?(?:the |what )?(?:changes|diff))(?:\s+(?:in|of|on|to)\s+(.+?))?$/i.exec(t))) {
    const x = m[1];
    if (!x) return { tool: 'code_changes', args: {} };
    if (/\.[a-z0-9]{1,6}$/i.test(x)) return { tool: 'code_changes', args: { file: x.trim() } };
    if (NOT_PROJECT.test(x)) return null;
    return { tool: 'code_changes', args: { project: name(x) } };
  }
  if ((m = /^(?:run|start) (?:the |my )?tests?(?:\s+(?:on|for|in|of)\s+(.+?))?$|^did (?:the |my )?tests? pass(?:\s+(?:on|for|in)\s+(.+?))?$|^(?:show (?:me )?)?(?:the )?test results?$/i.exec(t))) {
    const x = m[1] || m[2];
    return { tool: 'code_tests', args: x ? { project: name(x) } : {} };
  }
  return null;
}
