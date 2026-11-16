// Routines by voice, without the AI to recognise the words (the plan itself uses the AI once).
// Reminders keep "remind me …" and the plain "every morning tell me the weather" (reminders already do that).
const TIME = /^(?:every|each|har)\s+(?:(?:\d+\s+)?hours?|morning|evening|night|afternoon|day|weekday|week|(?:mon|tues|wednes|thurs|fri|satur|sun)day)s?\b/i;
const EVENT = /^(?:whenever|when)\s+(?:a\s+coding\s+task|the\s+coder|claude|the\s+team)\s+(?:finishes|is\s+done|completes|finishes\s+a\s+task)\b/i;
const MAKE = /^(?:make|create|set\s+up|add|start)\s+a\s+routine\b/i;
const LOOK = /\b(?:check|tell\s+me|show|sum\s+up|summari[sz]e|look\s+at|what\s+changed|status|board|github|calendar|battery|disk|space|leetcode|usage|notes|tasks|team|weather|activity|progress)\b/i;
const OTHER_THAN_WEATHER = /\b(?:github|board|calendar|battery|disk|space|leetcode|usage|notes|tasks|team|activity|progress|project|changed|claude)\b/i;

export function routineCommand(text) {
  const t = String(text || '').trim().replace(/^(?:ok(?:ay)?|hey novi|novi|please)[,\s]+/i, '').replace(/[?!.]+$/, '').trim();
  if (!t) return null;
  let m;
  if (/^(?:list|show(?:\s+me)?|what\s+are|tell\s+me)\s+(?:all\s+)?my\s+routines$/i.test(t)) return { tool: 'routine_list', args: {} };
  if ((m = /^run\s+(?:the\s+|my\s+)?(.+?)\s+routine(?:\s+now)?$/i.exec(t))) return { tool: 'routine_run', args: { name: m[1].toLowerCase() } };
  if ((m = /^what\s+did\s+(?:the\s+|my\s+)?(.+?)\s+routine\s+(?:say|find|report)$/i.exec(t))) return { tool: 'routine_said', args: { name: m[1].toLowerCase() } };
  if ((m = /^(?:pause|stop)\s+(?:the\s+|my\s+)?(.+?)\s+routine$/i.exec(t))) return { tool: 'routine_pause', args: { name: m[1].toLowerCase() } };
  if ((m = /^(?:resume|restart|unpause)\s+(?:the\s+|my\s+)?(.+?)\s+routine$/i.exec(t))) return { tool: 'routine_pause', args: { name: m[1].toLowerCase(), resume: true } };
  if ((m = /^(?:remove|delete|cancel)\s+(?:the\s+|my\s+)?(.+?)\s+routine$/i.exec(t))) return { tool: 'routine_remove', args: { name: m[1].toLowerCase() } };
  if (/\bremind\s+me\b/i.test(t)) return null;
  const said = String(text).trim();
  if (MAKE.test(t) || EVENT.test(t)) return { tool: 'routine_make', args: { said } };
  // "every day I check my github" says what you do, it doesn't ask Novi to (final review).
  if (/\b(?:i|we)\s+(?:usually\s+|always\s+|normally\s+)?(?:check|look|see|watch|read|open)\b/i.test(t)) return null;
  if (TIME.test(t) && LOOK.test(t)) {
    if (/\bweather\b/i.test(t) && !OTHER_THAN_WEATHER.test(t)) return null; // a reminder does that already
    return { tool: 'routine_make', args: { said } };
  }
  return null;
}
