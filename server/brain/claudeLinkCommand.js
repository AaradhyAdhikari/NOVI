// Novi ⇄ Claude by voice (user, 2026-10-18), no AI: "put portfolio on Claude", "make a Claude project
// for X", "add X to my Claude projects" → a claude.ai Project; "sync my Claude projects", "connect
// Novi to Claude", "bring in my old projects" → Claude Code's projects into Novi's memory.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|can you|could you|now|also)[, ]+)+/i;
const TAIL = /[\s,]*(?:please|for me|right now|now|too|as well)?[.!?]*$/i;
const CLAUDE = String.raw`(?:claude(?:\.ai| ai| app)?|my claude)`;
const name = (s) => s.replace(/^(?:the|my)\s+/i, '').replace(/\s+(?:project|folder|site|website|app)$/i, '').trim();

export function claudeLinkCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(TAIL, '');
  if (/^(?:sync|import|load|update|refresh)\s+(?:all\s+)?(?:my|the)\s+(?:old\s+|previous\s+)?claude(?: code)?\s+projects$/i.test(t)
    || /^connect\s+(?:novi|yourself|you)\s+(?:to|with)\s+claude(?: code)?$/i.test(t)
    || /^(?:bring|get|pull)\s+(?:in\s+)?(?:all\s+)?(?:of\s+)?my\s+(?:old|previous|earlier)\s+projects(?:\s+(?:in\s+)?from\s+claude(?: code)?)?$/i.test(t)
    || /^remember\s+(?:all\s+)?my\s+(?:old\s+|previous\s+)?claude(?: code)?\s+projects$/i.test(t)) {
    return { tool: 'claude_projects_sync', args: {} };
  }
  const m = new RegExp(String.raw`^(?:put|add|make|create|move|save)\s+(.+?)\s+(?:on|in|into|to)\s+${CLAUDE}(?:\s+projects?)?$`, 'i').exec(t)
    || new RegExp(String.raw`^(?:add|put)\s+(.+?)\s+to\s+(?:my\s+)?claude\s+projects$`, 'i').exec(t)
    || new RegExp(String.raw`^(?:make|create)\s+(?:a\s+)?(?:new\s+)?claude(?:\.ai)?\s+project\s+(?:for|of)\s+(.+)$`, 'i').exec(t);
  const project = m && name(m[1]);
  if (!project || /^(?:a|an|new|this|that|it)$/i.test(project)) return null;
  return { tool: 'claude_project_make', args: { project } };
}
