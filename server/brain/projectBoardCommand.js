// The project record by voice, without the AI (plugins/project-state, 2026-11-11): "show me the X board",
// "what's on the X board", "task board for X" → project_board; "decision for X: Y (because Z)",
// "note a decision for X: Y" → project_decision (the user's own words are the yes). "status of X" stays
// with project_status (claude-link).
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const name = (s) => String(s || '').trim().replace(/^(?:my|the|our)\s+/i, '').replace(/\s+(?:project|app)$/i, '').trim();

// Phase 3: the agent words at the end of a run/plan line. "with/using X" = the agent the user names (it
// wins), "without X" / "don't use X" = ruled out. Returned apart from the project name.
function agentTail(t) {
  let agent;
  let avoid;
  let s = t;
  s = s.replace(/,?\s*(?:don'?t|do not|never)\s+use\s+([a-z0-9 ]+?)(?=,|\s+(?:use|using|with)\b|$)/i, (_, x) => { avoid = x.trim(); return ''; });
  // Names may be several words ("the backup AI", "claude code") or several agents ("chatgpt and gemini").
  s = s.replace(/,?\s*without\s+((?:the\s+)?[a-z0-9]+(?:\s+(?:and|or|ai|code)\s*[a-z0-9]*)*)$/i, (_, x) => { avoid = x.replace(/^the\s+/i, ''); return ''; });
  s = s.replace(/,?\s*(?:with|using|use|via)\s+((?:the\s+)?[a-z0-9]+(?:\s+(?:and|or|ai|code)\s*[a-z0-9]*)*)$/i, (_, x) => { agent = x.replace(/^the\s+/i, ''); return ''; });
  return { rest: s.replace(/,\s*$/, '').trim(), ...(agent ? { agent: agent.toLowerCase() } : {}), ...(avoid ? { avoid: avoid.toLowerCase() } : {}) };
}

export function projectBoardCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[?!]+$/, '').replace(/\.$/, '').trim();
  let m;
  if ((m = /^(?:show(?: me)?|open|read(?: me)?|what'?s on|what is on)\s+(?:the\s+)?(.+?)(?:'s)?\s+(?:task\s+)?board$/i.exec(t))) return { tool: 'project_board', args: { project: name(m[1]) } };
  if ((m = /^(?:(?:the|my)\s+)?(?:task|project)\s+board\s+(?:for|of)\s+(.+)$/i.exec(t))) return { tool: 'project_board', args: { project: name(m[1]) } };
  if (/^(?:which|what)\s+agents?\s+(?:do you have|can you use|are there|do we have)|^(?:who|what)\s+can you use(?:\s+for\s+\w+)?$|^(?:list|show)\s+(?:me\s+)?(?:the\s+|your\s+)?(?:agents|team)$/i.test(t)) return { tool: 'project_agents', args: {} };
  // Phase 6: the team by voice.
  if ((m = /^(?:stop|pause|halt)\s+(?:all\s+(?:the\s+)?agents|all\s+the\s+team|the\s+team|the\s+agents|everyone|everybody)(?:\s+(?:on|for|in)\s+(.+))?$/i.exec(t))) return { tool: 'project_stop', args: m[1] ? { project: name(m[1]) } : {} };
  if ((m = /^(?:stop|pause|halt)\s+(?:the\s+|my\s+)?(.+?)\s+tasks$/i.exec(t))) return { tool: 'project_stop', args: { project: name(m[1]) } };
  if ((m = /^what\s+did\s+(.+?)\s+(?:say|answer|write|reply|come up with|find)(?:\s+(?:on|for|about|in)\s+(.+))?$/i.exec(t))
    || (m = /^what\s+(?:was|is)\s+(.+?)'s\s+(?:answer|reply|result|report)(?:\s+(?:on|for|about|in)\s+(.+))?$/i.exec(t))) {
    return { tool: 'project_said', args: { agent: m[1].trim().toLowerCase(), ...(m[2] ? { project: name(m[2]) } : {}) } };
  }
  if (/^(?:what'?s|what\s+is|what\s+are)\s+(?:the\s+)?(?:team|agents)\s+doing(?:\s+now|\s+right now)?$|^(?:the\s+)?team\s+status$|^who(?:'s|\s+is)\s+(?:working\s+on|doing)\s+what$|^(?:how'?s|how\s+is)\s+the\s+team\s+doing$/i.test(t)) return { tool: 'team_status', args: {} };
  if ((m = /^(?:undo|revert|roll\s*back)\s+(?:the\s+)?last\s+(?:task|merge|change|commit)\s+(?:on|for|in|of)\s+(.+)$/i.exec(t))) return { tool: 'project_undo', args: { project: name(m[1]) } };
  if (/^(?:run|start|do|continue|resume)\b/i.test(t)) {
    const { rest, ...who } = agentTail(t);
    if ((m = /^(?:run|start|do)\s+(?:the\s+|my\s+)?(.+?)\s+tasks$/i.exec(rest)) || (m = /^(?:run|start|do)\s+(?:the\s+)?next\s+task\s+(?:on|for|of|in)\s+(.+)$/i.exec(rest)) || (m = /^(?:continue|resume)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:project|tasks|work))$/i.exec(rest))) {
      return { tool: 'project_run', args: { project: name(m[1]), ...who } };
    }
  }
  if (/^(?:plan|make a plan for|break|split)\b/i.test(t)) {
    const { rest, agent } = agentTail(t);
    if ((m = /^(?:plan|make a plan for|break|split)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:into|in)\s+tasks)?$/i.exec(rest))) return { tool: 'project_plan', args: { project: name(m[1]), ...(agent ? { agent } : {}) } };
  }
  if ((m = /^(?:note|add|write|save)?\s*(?:a|the)?\s*decision\s+(?:for|in|on)\s+(.+?)\s*[:,-]\s*(.+)$/i.exec(t))) {
    const [, what, why = ''] = /^(.+?)(?:\s+because\s+(.+))?$/i.exec(m[2].trim());
    const decision = what.trim();
    return { tool: 'project_decision', args: { project: name(m[1]), title: decision.slice(0, 60), decision, reason: why.trim() } };
  }
  return null;
}
