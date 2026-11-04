import { useEffect, useRef, useState } from 'react';
import { X, CornerDownLeft, Delete, ArrowLeft, Send } from 'lucide-react';
import { onLive, tapPoint, scrollNotches } from '../lib/liveInput.js';

const MOVED_PX = 12; // less than this is a tap
const MAX_ZOOM = 4;
const bar = { display: 'flex', gap: 8, padding: '8px 12px', background: '#0b1016', alignItems: 'center' };
const button = { background: '#1b2733', color: '#e6ecf2', border: 0, borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 };

// The laptop's screen, full-screen on the phone. One finger: tap to click, drag to scroll.
// Two fingers: pinch to zoom and move around. The bar below types and presses keys.
export default function LiveScreen({ send }) {
  const [src, setSrc] = useState('');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const img = useRef(null);
  const fingers = useRef(new Map());
  const gesture = useRef(null);

  useEffect(() => {
    const stop = onLive((msg) => {
      if (msg.type === 'live_note') { setNote(msg.text); return; }
      if (msg.type === 'live_frame') setSrc(`data:image/png;base64,${msg.png}`);
      send({ type: 'live_ack' }); // the next picture only after this one arrived: no pile-up on a slow link
    });
    send({ type: 'live_ack' });
    return () => { stop(); send({ type: 'live_stop' }); };
  }, [send]);

  const input = (m) => send({ type: 'live_input', ...m });

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...fingers.current.values()];
    if (pts.length === 1) gesture.current = { kind: 'one', x: e.clientX, y: e.clientY, sent: 0, moved: false };
    if (pts.length === 2) {
      gesture.current = {
        kind: 'two', view, gap: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      };
    }
  };

  const move = (e) => {
    if (!fingers.current.has(e.pointerId)) return;
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'two' && fingers.current.size === 2) {
      const pts = [...fingers.current.values()];
      const gap = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const zoom = Math.max(1, Math.min(MAX_ZOOM, g.view.zoom * (gap / g.gap)));
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      setView(zoom === 1 ? { zoom: 1, x: 0, y: 0 } : { zoom, x: g.view.x + mid.x - g.mid.x, y: g.view.y + mid.y - g.mid.y });
    }
    if (g.kind === 'one') {
      const dy = e.clientY - g.y;
      if (Math.hypot(e.clientX - g.x, dy) >= MOVED_PX) g.moved = true;
      const notches = scrollNotches(dy) - g.sent;
      if (notches) { g.sent += notches; input({ kind: 'scroll', notches }); }
    }
  };

  const up = (e) => {
    fingers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'one' && !g.moved && img.current) {
      const point = tapPoint(img.current.getBoundingClientRect(), e.clientX, e.clientY);
      if (point) input({ kind: 'tap', ...point });
    }
    if (!fingers.current.size) gesture.current = null;
    else if (g?.kind === 'two') gesture.current = { kind: 'done' }; // the second finger lifting is not a tap
  };

  const typeIt = () => {
    if (!text.trim()) return;
    input({ kind: 'text', text });
    setText('');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#000', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      >
        {src
          ? <img ref={img} src={src} alt="Laptop screen" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, userSelect: 'none' }} />
          : <span style={{ color: '#9aa8b6' }}>Connecting to the laptop…</span>}
      </div>
      {note && <div style={{ background: '#3a2d12', color: '#f0c36a', padding: '8px 12px', fontSize: 14 }} onClick={() => setNote('')}>{note}</div>}
      <div style={bar}>
        <input
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') typeIt(); }}
          placeholder="Type on the laptop" autoComplete="off" autoCorrect="off"
          style={{ flex: 1, minWidth: 0, background: '#1b2733', color: '#e6ecf2', border: 0, borderRadius: 8, padding: '10px 12px', fontSize: 16 }}
        />
        <button style={button} onClick={typeIt} aria-label="Type it"><Send size={18} /></button>
      </div>
      <div style={{ ...bar, paddingTop: 0, paddingBottom: 'max(8px, env(safe-area-inset-bottom))', flexWrap: 'wrap' }}>
        <button style={button} onClick={() => input({ kind: 'key', key: 'enter' })}><CornerDownLeft size={18} />Enter</button>
        <button style={button} onClick={() => input({ kind: 'key', key: 'backspace' })} aria-label="Backspace"><Delete size={18} /></button>
        <button style={button} onClick={() => input({ kind: 'key', key: 'alt+left' })}><ArrowLeft size={18} />Back</button>
        <button style={button} onClick={() => input({ kind: 'key', key: 'esc' })}>Esc</button>
        <button style={{ ...button, marginLeft: 'auto' }} onClick={() => send({ type: 'live_stop' })}><X size={18} />Close</button>
      </div>
    </div>
  );
}
