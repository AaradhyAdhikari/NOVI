// Skills by voice, no AI (plugins/skills): find, install, remove, list. Installing and removing still show
// their card: the words only pick the tool.
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
const trim = (s) => String(s).trim().replace(/[.?!]+$/, '').trim();

export function skillCommand(text) {
  const t = trim(String(text || '').replace(/^(?:hey\s+)?novi[,!]?\s*/i, '').replace(/^(?:please|okay|ok|can you|could you)\s+/i, ''));
  if (/^(?:what|which)\s+skills\s+(?:do\s+i\s+have|are\s+installed|have\s+i\s+got)$|^(?:list|show)\s+(?:me\s+)?(?:my|the)?\s*(?:installed\s+)?skills$|^my\s+skills$/i.test(t)) return { tool: 'skill_list', args: {} };
  let m = /^(?:find|search\s+for|look\s+for|get)\s+(?:me\s+)?(?:a|any|some)?\s*skills?\s+(?:for|to|that|which)\s+(.+)$/i.exec(t)
    || /^(?:is|are)\s+there\s+(?:a|any)\s+skills?\s+(?:for|to|that)\s+(.+)$/i.exec(t);
  if (m) return { tool: 'skill_find', args: { query: trim(m[1]) } };
  m = /^(?:install|add)\s+(?:the\s+)?skill\s+(?:number\s+)?(\d+|one|two|three|four|five)$/i.exec(t)
    || /^(?:install|add)\s+(?:the\s+)?(?:number\s+)?(\d+|first|second|third|fourth|fifth)\s+(?:one|skill)$/i.exec(t)
    || /^(?:install|add)\s+number\s+(\d+|one|two|three|four|five)$/i.exec(t);
  if (m) return { tool: 'skill_install', args: { pick: Number(m[1]) || NUM[m[1].toLowerCase()] } };
  m = /^(?:install|add)\s+(?:the\s+)?(.+?)\s+skill(?:\s+from\s+clawhub)?$/i.exec(t) || /^(?:install|add)\s+(?:the\s+)?skill\s+(?:called\s+)?(.+)$/i.exec(t);
  if (m) return { tool: 'skill_install', args: { skill: trim(m[1]) } };
  m = /^(?:remove|uninstall|delete)\s+(?:the\s+)?(.+?)\s+skill$/i.exec(t) || /^(?:remove|uninstall|delete)\s+(?:the\s+)?skill\s+(?:called\s+)?(.+)$/i.exec(t);
  if (m) return { tool: 'skill_remove', args: { name: trim(m[1]) } };
  return null;
}
