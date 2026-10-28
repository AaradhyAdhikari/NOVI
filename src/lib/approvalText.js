// Approval cards: a long or multi-line detail (a coder's shell command, a full path) is folded
// behind "Show the command" so the card stays short and readable.
export const foldDetail = (text) => /\n/.test(String(text || '')) || String(text || '').length > 120;

// The short status shown for a moment after a card is answered (2026-10-28).
export function resolvedText(r = {}) {
  if (r.changed) return 'Change sent';
  if (r.answered) return 'Answer sent to Claude';
  if (r.by === 'timeout') return 'Timed out';
  if (!r.allow) return 'Denied';
  if (r.choice) return 'Option sent';
  return r.noted ? 'Approved, with your note' : 'Approved';
}
