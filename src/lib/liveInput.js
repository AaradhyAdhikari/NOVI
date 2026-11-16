// Touches on the live laptop picture (src/components/LiveScreen.jsx), and the pictures on their way to it.
const NOTCH_PX = 40; // one wheel notch per 40 px of finger movement
const MAX_NOTCHES = 10;

// Where a touch lands on the laptop screen, 0 to 1 each way. The picture's box already includes any zoom.
export function tapPoint(rect, clientX, clientY) {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

// Finger up (negative) moves the page down, which is a negative wheel, like a phone's own scrolling.
export function scrollNotches(dy) {
  const n = Math.trunc(dy / NOTCH_PX);
  return Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, n)) + 0;
}

let listener = null;
export const onLive = (fn) => { listener = fn; return () => { if (listener === fn) listener = null; }; };
export const emitLive = (msg) => listener?.(msg);

// A second tap within 350 ms on about the same spot is a double-tap (YouTube skip 5 s); else a tap.
export const DOUBLE_TAP_MS = 350;
export function tapKind(prev, now) {
  if (!prev || now.at - prev.at > DOUBLE_TAP_MS) return 'tap';
  return Math.abs(now.x - prev.x) < 0.06 && Math.abs(now.y - prev.y) < 0.06 ? 'doubletap' : 'tap';
}
