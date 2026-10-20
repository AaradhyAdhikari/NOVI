import crypto from 'node:crypto';

// The user's planning chat on ChatGPT (2026-10-20): pure helpers for saving it and cross-checking it.

// A real chat (chatgpt.com/c/<id>, also inside a custom GPT) keeps updating; a share link is a snapshot.
export function chatKind(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(u.hostname)) return null;
  if (/\/c\/[\w-]+/.test(u.pathname)) return 'chat';
  if (/^\/share\/[\w-]+/.test(u.pathname)) return 'share';
  return null;
}

export const messageKey = (m) => crypto.createHash('sha1').update(`${m.role}\n${m.text}`).digest('hex').slice(0, 16);

export const newSince = (seen, messages) => {
  const known = new Set(seen || []);
  return messages.filter((m) => !known.has(messageKey(m)));
};

const WHO = { you: 'You', chatgpt: 'ChatGPT' };
export function toMarkdown({ title, source, syncedAt, messages }) {
  const head = `# ChatGPT: ${title}\n\nSource: ${source}\nLast synced: ${syncedAt}\nPrivate copy kept by Novi (plugins/chatgpt-plan). Never pushed to GitHub.\n`;
  return `${head}\n${messages.map((m, i) => `## ${i + 1}. ${WHO[m.role] || m.role}\n\n${m.text}\n`).join('\n')}`;
}

// The new ChatGPT messages (newest kept when long) + the project guide (CLAUDE.md, cut to size).
export function crosscheckPrompt({ fresh, guide }) {
  const chat = fresh.map((m) => `[${WHO[m.role] || m.role}]\n${m.text}`).join('\n\n').slice(-20_000);
  return `You cross-check a plan from ChatGPT against what is already built in Novi, a voice-first personal AI companion.
Below is Novi's project guide (its rules, what is done, and the current state), then the new messages from the user's ChatGPT planning chat.

For every concrete suggestion or step in the new ChatGPT messages, write one line:
- [Done] <suggestion> — where in Novi it already exists (file or feature name from the guide)
- [Partly] <suggestion> — what exists and what is missing
- [Not built] <suggestion> — one short line on how it would fit Novi (which plugin or file)
- [Against your rules] <suggestion> — which rule of the guide it breaks (e.g. paid APIs, Claude only for coding, approvals)
Then "Next for Claude:" with the 1–3 most useful [Not built]/[Partly] items to implement, in order.
Only use what the guide says; if unsure, say [Not sure]. Plain short English, no intro.

=== Novi project guide ===
${String(guide || '(not found)').slice(0, 60_000)}

=== New ChatGPT messages ===
${chat}`;
}
