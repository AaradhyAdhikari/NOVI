// "Send that to Claude in NOVI": the last AI answer goes to Claude only on words like these (plugins/ai-cards).
const LEAD = /^(?:(?:ok(?:ay)?|hey novi|novi|please|so|now|yes)[,\s]+)*(?:(?:can|could|will) you\s+)?(?:please\s+)?/i;
const AI = 'chatgpt|gemini|perplexity|gamma';
const WHAT = String.raw`(?:that|it|this|(?:that |the |this )?(?:last )?(?:(${AI})(?:'s)? )?(?:answer|reply|one)|(${AI})(?:'s)? (?:answer|reply))`;
const SEND = new RegExp(String.raw`^send ${WHAT} to claude(?:\s+(?:in|on|for)\s+(?:my\s+|the\s+)?(.+?))?(?:\s+project)?$`, 'i');
const BHEJ = /^(?:ye|yeh|isko|use|usko)?\s*claude ko bhej(?: do|o| dena)?$/i;

export function aiSendCommand(text) {
  const t = String(text || '').trim().replace(LEAD, '').replace(/[.!?]+$/, '').trim();
  if (BHEJ.test(t)) return { tool: 'ai_answer_send', args: {} };
  const m = SEND.exec(t);
  if (!m) return null;
  const site = (m[1] || m[2] || '').toLowerCase();
  return { tool: 'ai_answer_send', args: { ...(m[3] ? { project: m[3].trim() } : {}), ...(site ? { site } : {}) } };
}
