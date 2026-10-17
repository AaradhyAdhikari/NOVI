// Approval cards: a long or multi-line detail (a coder's shell command, a full path) is folded
// behind "Show the command" so the card stays short and readable.
export const foldDetail = (text) => /\n/.test(String(text || '')) || String(text || '').length > 120;
