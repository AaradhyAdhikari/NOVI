// "Open Spotify" / "Spotify chalu karo", without the AI (checklist rows open2-open4). orSite: "X kholo" also fits a
// website, so when no app has that name it goes on to the browser route.
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const TAIL = /\s+(?:on (?:my|the) (?:laptop|computer|pc)|laptop (?:pe|par|mein)|for me|right now|now|please)$/i;
const OPEN = /^(?:open|launch|start)\s+(?:up\s+)?(?:the\s+|my\s+)?(.+)$/i;
const HINGLISH = /^(?:(?:the|my)\s+)?(.+?)\s+(?:kholo|khol do|chalu karo|chalu kar do|start karo|start kar do|open karo|open kar do|shuru karo|launch karo)$/i;
const APP_WORD = /\s+(?:app|application)$/i;
// Things that are not apps, or that another route handles.
const NOT_APP = /\b(?:page|tab|tabs|link|links|website|site|file|files|folder|folders|note|notes|timer|reminder|alarm|project|control|screen|mode|new|and|then|aur|it|this|that|wifi|wi-fi|bluetooth|hotspot|music|song|video|preview)\b|\.[a-z]{2,}\b/i;

export function appCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '').replace(LEAD, '').replace(TAIL, '').trim();
  const english = OPEN.exec(t);
  const hinglish = english ? null : HINGLISH.exec(t);
  const raw = (english || hinglish)?.[1];
  if (!raw) return null;
  const name = raw.replace(APP_WORD, '').trim().toLowerCase();
  if (!name || name.split(/\s+/).length > 3 || NOT_APP.test(name)) return null;
  return { name, orSite: Boolean(hinglish) };
}
