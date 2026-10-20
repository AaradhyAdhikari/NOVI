// "Sync my pinned chats" / "check my ChatGPT plan" without the AI (live 2026-10-20: the AI turned the
// tool's "Checking…" into "Your pinned chats have been synced", then the real result said timeout).
export function chatgptCommand(text) {
  const t = String(text || '').toLowerCase().replace(/[.!?]+$/, '').trim();
  const gpt = /\b(?:chat ?gpt|gpt)\b/.test(t);
  const verb = /\b(?:sync|check|update|refresh|read|pull)\b/.test(t);
  if (verb && /\bpinned chats?\b/.test(t)) return { tool: 'chatgpt_plan_sync', args: {} };
  if (gpt && verb && /\b(?:plan|plans|chat|chats|projects?|pinned)\b/.test(t)) return { tool: 'chatgpt_plan_sync', args: {} };
  if (gpt && /^(?:sync|check|update|refresh)(?: my)? (?:chat ?gpt|gpt)$/.test(t)) return { tool: 'chatgpt_plan_sync', args: {} };
  if (/\bwhat (?:did|has) (?:chat ?gpt|gpt) plan(?:ned)?\b/.test(t)) return { tool: 'chatgpt_plan_sync', args: {} };
  return null;
}
