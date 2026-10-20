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
    || /^remember\s+(?:all\s+)?my\s+(?:old\s+|previous\s+)?claude(?: code)?\s+projects$/i.test(t)
    || /^sync\s+(?:every|all)(?:\s+(?:of\s+)?(?:my|the))?\s+projects?\b.*\bclaude\b/i.test(t)) {
    return { tool: 'claude_projects_sync', args: {} };
  }
  // "Open TraceBite on claude.ai" / "open my FlexR Claude project" = its claude.ai page; "open X on/in Claude"
  // too, but only when X isn't a folder project (that one opens in Claude Code) — soft.
  const site = new RegExp(String.raw`^open\s+(.+?)\s+(?:on|in)\s+(?:claude\.ai|claude ai|the claude website|claude website)$`, 'i').exec(t)
    || /^open\s+(.+?)\s+claude(?:\.ai)?\s+project$/i.exec(t);
  if (site) return { tool: 'claude_project_open', args: { project: name(site[1]) } };
  const soft = /^open\s+(.+?)\s+(?:on|in)\s+claude$/i.exec(t);
  if (soft && !/^claude/i.test(soft[1])) return { tool: 'claude_project_open', args: { project: name(soft[1]) }, soft: true };
  const m = new RegExp(String.raw`^(?:put|add|make|create|move|save)\s+(.+?)\s+(?:on|in|into|to)\s+${CLAUDE}(?:\s+projects?)?$`, 'i').exec(t)
    || new RegExp(String.raw`^(?:add|put)\s+(.+?)\s+to\s+(?:my\s+)?claude\s+projects$`, 'i').exec(t)
    || new RegExp(String.raw`^(?:make|create)\s+(?:a\s+)?(?:new\s+)?claude(?:\.ai)?\s+project\s+(?:for|of)\s+(.+)$`, 'i').exec(t);
  const project = m && name(m[1]);
  if (!project || /^(?:a|an|new|this|that|it)$/i.test(project)) return null;
  return { tool: 'claude_project_make', args: { project } };
}

// "Link the FLEXR context file to my FlexR project", "the folder for FlexR is C:\…", or a pasted path on
// its own (live 2026-10-18: the AI kept asking for the path, even after it was pasted). No AI.
// → { project?, path? | name? }: path = an absolute path as written, name = what the folder is called.
const ABS = /^(?:[A-Za-z]:[\\/]|\\\\|\/)\S/;
const unquote = (s) => String(s || '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
const LINK_TAIL = /[\s,]*(?:according to (?:you|u)|please|for me|right now|now)?[.!?]*$/i;
const targetOf = (s) => {
  const t = unquote(s);
  if (ABS.test(t)) return { path: t };
  const n = t.replace(/^(?:the|my)\s+/i, '').replace(/\s+(?:file|folder|files|folders)$/i, '').trim();
  return n ? { name: n } : null;
};

export function linkFolderCommand(text) {
  const raw = unquote(String(text || '').replace(/[.!?]+$/, ''));
  if (ABS.test(raw) && !/\s(?:to|with|into)\s/i.test(raw)) return { path: raw };
  const t = String(text || '').trim().replace(LEAD, '').replace(LINK_TAIL, '');
  let project = null;
  let target = null;
  const m = /^(?:link|attach|connect|sync|add|put|save)\s+(.+?)\s+(?:to|with|into|in)\s+(?:my\s+|the\s+)?(.+?)\s+project$/i.exec(t);
  const f = /^(?:the\s+)?(?:folder|path)\s+(?:for|of)\s+(?:my\s+|the\s+)?(.+?)(?:\s+project)?\s+is\s+(.+)$/i.exec(t)
    || /^(?:my\s+|the\s+)?(.+?)\s+project\s+is\s+(?:in|at)\s+(.+)$/i.exec(t);
  if (m) { project = m[2]; target = targetOf(m[1]); } else if (f) { project = f[1]; target = targetOf(f[2]); }
  project = project?.trim();
  if (!project || !target || /^claude/i.test(project)) return null;
  return { project, ...target };
}

// "Tell me till date progress of that FlexR project (on Claude)", "status of portfolio", "what's next for
// FLEXR", "where did I leave off on X", "X ka progress kya hai" → project_status (no AI to route it).
// Without a project ("what's the progress") it stays the running coding task's quick answer.
const NOT_A_PROJECT = /^(?:it|this|that|the task|the coding|claude|my order|the order|the weather|weather|order)$/i;
export function projectStatusCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '');
  const m = /^(?:(?:tell me|give me|show me)\s+)?(?:what(?:'s| is)\s+)?(?:the\s+)?(?:till date\s+|overall\s+|current\s+|latest\s+)?(?:progress|status|updates?)\s+(?:of|on|for|in|with)\s+(.+)$/i.exec(t)
    || /^what(?:'s| is)\s+next\s+(?:for|on|in|with)\s+(.+)$/i.exec(t)
    || /^where\s+(?:did\s+i\s+leave\s+off|are\s+we|am\s+i)\s+(?:on|with|in)\s+(.+)$/i.exec(t)
    || /^(.+?)\s+(?:ka|ki|ke)\s+(?:progress|status|update)\s+(?:kya\s+hai|batao|bata do)$/i.exec(t);
  if (!m) return null;
  const project = m[1].replace(/\s+(?:on|in)\s+claude(?:\.ai)?$/i, '').replace(/^(?:that|my|the|this)\s+/i, '').replace(/\s+project$/i, '').trim();
  if (!project || NOT_A_PROJECT.test(project) || project.split(/\s+/).length > 4) return null;
  return { tool: 'project_status', args: { project } };
}
