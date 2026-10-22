// Keeps a page Novi works in (ChatGPT, Gemini, claude.ai in Novi's minimized window) running as if it
// were on screen. Chrome stops drawing hidden tabs, and some sites then never show their answer (live
// 2026-10-20: Gemini stayed "Gemini said" until its tab came forward). Runs first in every page, but
// does something only in a tab Novi opened for its own work: marked "#novi-work" on its first load, a
// mark that tab keeps in its sessionStorage. Your own tabs are never changed.
function stayAwake() {
  try { sessionStorage.setItem('__noviWork', '1'); } catch { /* no storage */ } // Novi's mark on this tab
  if (window.__noviAwake) return;
  window.__noviAwake = true;
  const proto = Document.prototype;
  const real = Object.getOwnPropertyDescriptor(proto, 'hidden');
  const reallyHidden = () => { try { return real?.get ? real.get.call(document) : false; } catch { return false; } };
  for (const [k, v] of [['hidden', false], ['webkitHidden', false], ['visibilityState', 'visible'], ['webkitVisibilityState', 'visible']]) {
    try { Object.defineProperty(proto, k, { configurable: true, get: () => v }); } catch { /* keep going */ }
  }
  proto.hasFocus = () => true;
  const block = (e) => e.stopImmediatePropagation();
  for (const t of ['visibilitychange', 'webkitvisibilitychange']) {
    window.addEventListener(t, block, true);
    document.addEventListener(t, block, true);
  }
  // Drawing callbacks never run in a hidden tab: run them on a timer instead (Chrome allows about one a
  // second there — enough for Novi, which reads the page every 1.5 s).
  const raf = window.requestAnimationFrame?.bind(window);
  const caf = window.cancelAnimationFrame?.bind(window);
  const timers = new Map();
  let next = 0;
  window.requestAnimationFrame = (cb) => {
    if (!reallyHidden() && raf) return raf(cb);
    next -= 1;
    const id = next;
    timers.set(id, setTimeout(() => { timers.delete(id); cb(performance.now()); }, 16));
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); } else caf?.(id);
  };
}

if (typeof document !== 'undefined') {
  try {
    if (location.hash.includes('novi-work')) {
      sessionStorage.setItem('__noviWork', '1');
      history.replaceState(history.state, '', location.href.replace(/#novi-work$/, ''));
    }
    if (sessionStorage.getItem('__noviWork') === '1') stayAwake();
  } catch { /* a page without storage: left alone */ }
}
