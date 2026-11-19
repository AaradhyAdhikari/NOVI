// What the phone is showing when the wrist flicks (user, 2026-11-19: a flicked card opens the same card on the
// laptop, not a screenshot). A file open inside a card wins, then the flick screen's own card, then the top card.
const state = { file: null, card: null };

export function shownFor({ file, flickScreen, card }) {
  if (file) return { card: file.changes && file.changes !== file.card ? `${file.card}~${file.changes}` : file.card, file: file.file };
  if (flickScreen) return null; // the flick screen sends its own top card (window.__noviFlick)
  return card ? { card } : null;
}

export function setShownFile(v) { state.file = v; install(); }
export function setShownCard(id) { state.card = id || null; install(); }

function install() {
  if (typeof window === 'undefined') return;
  window.__noviShown = () => {
    const out = shownFor({ file: state.file, flickScreen: !!window.__noviFlick, card: state.card });
    return out ? JSON.stringify(out) : '';
  };
}
