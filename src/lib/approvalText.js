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

// A question where several options can be picked: a tap adds or removes one, Submit sends them.
export const togglePick = (picked, label) => (picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]);
export const pickedAnswer = (options, picked) => options.map((o) => o.label).filter((l) => picked.includes(l)).join(', ');

// The card a link opened ("Read the whole plan" on the phone): its detail starts unfolded.
export const openedCard = (search, id) => new URLSearchParams(search || '').get('card') === id;
