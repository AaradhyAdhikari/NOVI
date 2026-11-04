import { useEffect, useRef, useState } from 'react';
import { pinchView, panView, tapResult } from '../lib/zoom.js';

const MOVED_PX = 10; // less than this is a tap
const DOUBLE_MS = 300;
const TAP_ZOOM = 2.5;
const FLAT = { zoom: 1, x: 0, y: 0 };

// A full-screen picture: two fingers zoom, one finger moves it, a double tap zooms in or back out,
// and one tap at normal size closes it.
export default function ZoomImage({ src, alt, onClose }) {
  const [view, setView] = useState(FLAT);
  const viewRef = useRef(view);
  viewRef.current = view;
  const box = useRef(null);
  const fingers = useRef(new Map());
  const gesture = useRef(null);
  const lastTap = useRef(0);
  const closing = useRef(null);
  useEffect(() => () => clearTimeout(closing.current), []);

  const size = () => {
    const r = box.current.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  const fromMiddle = (x, y) => {
    const r = box.current.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };
  const pinchNow = () => {
    const [a, b] = [...fingers.current.values()];
    return { gap: Math.hypot(a.x - b.x, a.y - b.y), mid: fromMiddle((a.x + b.x) / 2, (a.y + b.y) / 2) };
  };

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.current.size === 1) gesture.current = { kind: 'one', x: e.clientX, y: e.clientY, moved: false };
    if (fingers.current.size === 2) gesture.current = { kind: 'two', view: viewRef.current, ...pinchNow() };
  };

  const move = (e) => {
    const finger = fingers.current.get(e.pointerId);
    if (!finger) return;
    const dx = e.clientX - finger.x;
    const dy = e.clientY - finger.y;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g?.kind === 'two' && fingers.current.size === 2) {
      const now = pinchNow();
      setView(pinchView(g, now.gap, now.mid, size()));
    }
    if (g?.kind === 'one') {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= MOVED_PX) g.moved = true;
      if (g.moved) setView((v) => panView(v, dx, dy, size()));
    }
  };

  const tap = () => {
    const double = Date.now() - lastTap.current < DOUBLE_MS;
    lastTap.current = double ? 0 : Date.now();
    clearTimeout(closing.current);
    const what = tapResult(viewRef.current, double);
    if (what === 'zoom') setView({ ...FLAT, zoom: TAP_ZOOM });
    if (what === 'reset') setView(FLAT);
    if (what === 'close') closing.current = setTimeout(onClose, DOUBLE_MS); // a second tap may still come
  };

  const up = (e) => {
    fingers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'one' && !g.moved) tap();
    if (!fingers.current.size) gesture.current = null;
    else if (g?.kind === 'two') gesture.current = { kind: 'done' }; // the second finger lifting is not a tap
  };

  return (
    <div ref={box} className="viewer-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} />
    </div>
  );
}
