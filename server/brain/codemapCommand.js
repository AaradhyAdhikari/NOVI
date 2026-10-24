// The code map by voice without the AI (plugins/codemap): "map the Novi code", "show me the Novi
// code map", "how does the orchestrator connect to the task manager (in Novi)", "explain the
// ApprovalQueue class", "what uses the task manager". Explaining needs a code word (class /
// function / module…) so "explain the theory of relativity" stays with the AI; an answer the map
// doesn't have (`unknown`) goes on to the AI too (agent.js).
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?(?:tell me\s+)?/i;
const KIND = '(?:code(?:base)?|project|repo(?:sitory)?|app)';
const CODE = '(?:class|function|method|module|component|file|hook|service)';
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/'s$/i, '').trim();
const withProject = (args, project) => (project ? { ...args, project: name(project) } : args);

export function codemapCommand(text) {
  let t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  let m;
  // Make / refresh.
  if ((m = new RegExp(`^(?:map|graph)\\s+(.+?)(?:'s)?\\s+${KIND}$`, 'i').exec(t))) return { tool: 'codemap_build', args: { project: name(m[1]) } };
  if ((m = new RegExp(`^graphify\\s+(.+?)(?:\\s+${KIND})?$`, 'i').exec(t))) return { tool: 'codemap_build', args: { project: name(m[1]) } };
  if ((m = new RegExp(`^(?:make|build|create|update|refresh|redo)\\s+(?:a|an|the|my)?\\s*code\\s*map(?:\\s+(?:of|for)\\s+(.+?)(?:\\s+${KIND})?)?$`, 'i').exec(t))) {
    return { tool: 'codemap_build', args: withProject({}, m[1]) };
  }
  // Show.
  if ((m = new RegExp(`^(?:show|open|send)(?:\\s+me)?\\s+(?:the\\s+|my\\s+)?(?:(.+?)\\s+)?code\\s*map(?:\\s+(?:of|for)\\s+(.+?)(?:\\s+${KIND})?)?$`, 'i').exec(t))) {
    return { tool: 'codemap_show', args: withProject({}, m[2] || m[1]) };
  }
  // "… in (my) Novi (code)" names the project.
  let project = null;
  const inProject = new RegExp(`\\s+in\\s+(?:my\\s+|the\\s+)?([\\w .-]{2,40}?)(?:'s)?(?:\\s+${KIND})?$`, 'i').exec(t);
  if (inProject) { project = inProject[1]; t = t.slice(0, inProject.index); }
  // How two parts connect.
  if ((m = /^how\s+(?:does|do|is|are)\s+(.+?)\s+(?:connect(?:ed)?|link(?:ed)?|talk|get|reach|lead)\s+(?:to|with)\s+(.+)$/i.exec(t))
    || (m = /^what\s+connects\s+(.+?)\s+(?:and|to|with)\s+(.+)$/i.exec(t))) {
    return { tool: 'codemap_ask', args: withProject({ part: name(m[1]), to: name(m[2]) }, project) };
  }
  // One part.
  if ((m = new RegExp(`^(?:explain|describe)\\s+(.+?)\\s+${CODE}$`, 'i').exec(t))
    || (m = new RegExp(`^what\\s+(?:does|is)\\s+(.+?)\\s+${CODE}(?:\\s+do)?$`, 'i').exec(t))
    || (m = new RegExp(`^where\\s+is\\s+(.+?)\\s+(?:${CODE}|defined|used)$`, 'i').exec(t))) {
    return { tool: 'codemap_ask', args: withProject({ part: name(m[1]) }, project) };
  }
  if ((m = /^(?:what|who)\s+(?:uses|calls|imports)\s+(.+)$/i.exec(t))) {
    return { tool: 'codemap_ask', args: withProject({ part: name(m[1]), users: true }, project) };
  }
  return null;
}
