// Novi Flick by voice, no AI: "open the stage" / "flick mode", "close the stage", "open the last flick",
// v2: "copy the last flick", "send the last flick to ChatGPT", "send it to Rahul on WhatsApp",
// "show the last flick in the folder". "it" counts only right after a flick landed (flick_do recent: true;
// otherwise the words go on to the other routes).
import { AI_SITES } from '../../plugins/flick/sites.js';

const LEAD = /^(?:okay|ok|hey novi|novi|please|can you|could you)[,\s]+/i;
const clean = (t) => String(t || '').trim().replace(/[.!?]+$/, '').replace(LEAD, '').replace(/\s+please$/i, '').trim().toLowerCase();
const FLICK = '(?:the |my )?(?:last |latest |newest )?(?:flick|flicked (?:photo|picture|pic|image|file|link|video|thing|item))';
const AI_WORDS = { chatgpt: 'chatgpt', 'chat gpt': 'chatgpt', gemini: 'gemini', claude: 'claude', perplexity: 'perplexity', google: 'google', 'google lens': 'google', lens: 'google' };
const keep = (raw, word) => (String(raw).match(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')) || [word])[0];

// "Send this to my laptop" said on the phone (Novi mic button): the phone flicks what's on its screen.
const TO_LAPTOP = /^(?:send|flick|share|put|throw|move|cast)(?: (?:this|it|that|the|my))?(?: (?:photo|picture|pic|image|screenshot|screen|page|link|video|file|thing))?(?: over)? (?:to|on|onto) (?:my |the )?(?:laptop|computer|pc)(?: screen)?$|^(?:ye|yeh|isko|isse) laptop (?:pe|par) (?:bhejo|bhej do|daalo|dalo)$/;

export function flickCommand(text) {
  const t = clean(text);
  if (TO_LAPTOP.test(t)) return { tool: 'flick_from_phone', args: {} };
  if (/^(?:open|show|start|bring up)(?: the| my| novi)? (?:stage|flick stage)$|^(?:flick|stage) mode(?: on)?$|^stage kholo$/.test(t)) return { tool: 'flick_stage', args: { do: 'open' } };
  if (/^(?:close|hide|stop|end)(?: the| my| novi)? (?:stage|flick stage)$|^(?:flick|stage) mode off$|^stage band karo$/.test(t)) return { tool: 'flick_stage', args: { do: 'close' } };
  if (/^open (?:the |my )?(?:last|latest|newest) (?:flick|flicked (?:thing|file|item))$|^open what i (?:just )?flicked$/.test(t)) return { tool: 'flick_open', args: {} };
  if (new RegExp(`^copy ${FLICK}$`).test(t)) return { tool: 'flick_do', args: { action: 'copy' } };
  if (new RegExp(`^(?:show|open) ${FLICK} in (?:the |its )?folder$|^show me where ${FLICK} (?:is|went)$`).test(t)) return { tool: 'flick_do', args: { action: 'folder' } };
  if (new RegExp(`^open ${FLICK} in (?:the )?browser$`).test(t)) return { tool: 'flick_do', args: { action: 'browser' } };
  // "send the last flick / it to X (on WhatsApp)": X an AI site → that site, else a WhatsApp contact.
  const m = t.match(new RegExp(`^(?:send|share|forward) (${FLICK}|it|that|this) to (.+?)(?: on whatsapp)?$`));
  if (m) {
    const recent = /^(?:it|that|this)$/.test(m[1]);
    const who = m[2].replace(/^(?:my |the )/, '').trim();
    if (!who || /\b(?:phone|laptop|tv|screen)\b/.test(who)) return null;
    const app = AI_WORDS[who];
    if (app && AI_SITES[app]) return { tool: 'flick_do', args: { action: 'ai', app, ...(recent ? { recent: true } : {}) } };
    if (recent && !/on whatsapp$/.test(t)) return null; // "send it to Rahul" with no WhatsApp: another route's words
    return { tool: 'flick_do', args: { action: 'whatsapp', to: keep(text, who), ...(recent ? { recent: true } : {}) } };
  }
  return null;
}
