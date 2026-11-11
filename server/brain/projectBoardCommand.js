// The project record by voice, without the AI (plugins/project-state, 2026-11-11): "show me the X board",
// "what's on the X board", "task board for X" → project_board; "decision for X: Y (because Z)",
// "note a decision for X: Y" → project_decision (the user's own words are the yes). "status of X" stays
// with project_status (claude-link).
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:project|app)$/i, '').trim();

export function projectBoardCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[?!]+$/, '').replace(/\.$/, '').trim();
  let m;
  if ((m = /^(?:show(?: me)?|open|read(?: me)?|what'?s on|what is on)\s+(?:the\s+)?(.+?)(?:'s)?\s+(?:task\s+)?board$/i.exec(t))) return { tool: 'project_board', args: { project: name(m[1]) } };
  if ((m = /^(?:(?:the|my)\s+)?(?:task|project)\s+board\s+(?:for|of)\s+(.+)$/i.exec(t))) return { tool: 'project_board', args: { project: name(m[1]) } };
  if ((m = /^(?:plan|make a plan for|break|split)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:into|in)\s+tasks)?$/i.exec(t))) return { tool: 'project_plan', args: { project: name(m[1]) } };
  if ((m = /^(?:note|add|write|save)?\s*(?:a|the)?\s*decision\s+(?:for|in|on)\s+(.+?)\s*[:,-]\s*(.+)$/i.exec(t))) {
    const [, what, why = ''] = /^(.+?)(?:\s+because\s+(.+))?$/i.exec(m[2].trim());
    const decision = what.trim();
    return { tool: 'project_decision', args: { project: name(m[1]), title: decision.slice(0, 60), decision, reason: why.trim() } };
  }
  return null;
}
