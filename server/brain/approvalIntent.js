// What the user's words mean for the card Novi is waiting on — one parser for every card (user's plan,
// 2026-10-28): Claude's questions, Claude's permission cards, the brief, preview / file cards, high-risk
// and PIN cards. No AI. The agent decides what to do with the result (server/brain/agent.js _answerCard).
import { answerKind } from './answers.js';
import { changeCommand } from './briefCommand.js';
import { optionMatch } from '../claude/questions.js';

const SKIP = /^(?:skip|skip it|cancel|cancel it|chhodo|chodo|rehne do|rahne do|none|koi bhi nahi|kuch nahi)$/i;
const YES = '(?:yes|yeah|yep|ok|okay|sure|allow|approve|approved|go ahead|do it|haan|han|ha|theek hai|thik hai)';
const NOTE = new RegExp(`^${YES}[,.]?\\s+(?:but|lekin|magar|par)[,]?\\s+(.+)$`, 'i');
const ALSO = /^(?:(?:yes|yeah|ok|okay|haan|sure|allow|approve)[, ]+)?(?:and )?(?:also|plus)[, ]+(.+)$|^aur (?:bhi )?(.+)$/i;
const ACTUALLY = /^actually[,]?\s+(.+)$/i;

const optionsOf = (card) => (card?.question ? card.question.options || [] : card?.choices || []);

// → { intent: 'approve' (always?) | 'deny' | 'skip' | 'option' (optionIndex, optionLabel) | 'ambiguous'
//   (candidates) | 'approve_with_note' (note) | 'addition' (note) | 'change' (change) | 'answer' (text,
//   Claude's questions only) | 'unknown' }
export function parseApproval(text, card = {}) {
  const raw = String(text || '').trim();
  const t = raw.replace(/[.!?।]+$/, '').trim();
  const isQuestion = Boolean(card.question);
  if (!t) return { intent: 'unknown' };
  if (SKIP.test(t)) return { intent: isQuestion ? 'skip' : 'deny' };
  const change = changeCommand(t) || ACTUALLY.exec(t)?.[1]?.trim();
  if (change) return { intent: 'change', change };
  const note = NOTE.exec(t)?.[1]?.trim();
  if (note) return { intent: 'approve_with_note', note };
  const also = ALSO.exec(t);
  if (also) return { intent: 'addition', note: (also[1] || also[2]).trim() };
  const options = optionsOf(card);
  const picked = optionMatch(t, options);
  if (picked?.index !== undefined) return { intent: 'option', optionIndex: picked.index, optionLabel: options[picked.index].label };
  if (picked?.ambiguous) return { intent: 'ambiguous', candidates: picked.ambiguous.map((i) => ({ optionIndex: i, optionLabel: options[i].label })) };
  const kind = answerKind(t);
  if (isQuestion) {
    if (kind === 'deny') return { intent: 'skip' };
    if (kind) return { intent: 'unknown' }; // a plain yes doesn't say which option
    return { intent: 'answer', text: raw };
  }
  if (kind === 'approve-always') return { intent: 'approve', always: true };
  if (kind === 'approve') return { intent: 'approve' };
  if (kind === 'deny') return { intent: 'deny' };
  return { intent: 'unknown' };
}
