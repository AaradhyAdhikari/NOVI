// "NOVI CONTEXT and NOVI are the same" / "Signsync and Signsyncer are different" (user, 2026-10-20:
// same thing = one dot) → the wiki plugin's same_set, without the AI. Needs two names joined by and/aur.
// "Novi," only with its comma: NOVI is also a project name ("NOVI CONTEXT and NOVI are the same").
const LEAD = /^(?:(?:ok(?:ay)?|hey|hi)[,\s]+)?(?:novi,\s*)?(?:remember (?:that )?|note that |fyi,? )?/i;
const KIND = '(?:thing|things|project|projects|one|chat|chats)';

export function sameCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  const pick = (a, b, same) => {
    const [x, y] = [a, b].map((s) => s.trim().replace(/^(?:the|my) /i, ''));
    if (!x || !y || x.toLowerCase() === y.toLowerCase() || /^(?:they|it|this|that|these|those)$/i.test(x)) return null;
    return { tool: 'same_set', args: { a: x, b: y, same } };
  };
  let m = new RegExp(`^(.+?) and (.+?) are (?:the )?same(?: ${KIND})?$`, 'i').exec(t)
    || new RegExp(`^(.+?) and (.+?) are (?:one and the same|one ${KIND})$`, 'i').exec(t);
  if (m) return pick(m[1], m[2], true);
  m = /^(.+?) is the same (?:thing |project )?as (.+)$/i.exec(t);
  if (m && !/^(?:it|this|that|is it)$/i.test(m[1])) return pick(m[1], m[2], true);
  m = /^(.+?) aur (.+?) (?:ek hi|same) (?:hai|hain|he|cheez hai|project hai)$/i.exec(t);
  if (m) return pick(m[1], m[2], true);
  m = new RegExp(`^(.+?) and (.+?) (?:are different|are not the same|aren't the same|are two different)(?: ${KIND})?$`, 'i').exec(t);
  if (m) return pick(m[1], m[2], false);
  m = /^(.+?) aur (.+?) (?:alag|alag alag|different) (?:hai|hain|he)$/i.exec(t);
  if (m) return pick(m[1], m[2], false);
  return null;
}
