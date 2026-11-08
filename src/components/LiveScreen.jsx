import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import { X, CornerDownLeft, Delete, ArrowLeft, Send, Mic, MicOff, RotateCw, Keyboard } from 'lucide-react';
import { onLive, tapPoint, scrollNotches } from '../lib/liveInput.js';
import { answerOffer } from '../lib/liveVideo.js';
import { phoneSpeech, onHeard } from '../lib/phoneSpeech.js';

const MOVED_PX = 12; // less than this is a tap
const MAX_ZOOM = 4;
const bar = { display: 'flex', gap: 8, padding: '8px 12px', background: '#0b1016', alignItems: 'center' };
const button = { background: '#1b2733', color: '#e6ecf2', border: 0, borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 };

// The laptop's screen, full-screen on the phone: smooth video (plugins/live-screen/stream.js), else pictures.
// One finger: tap to click, drag to scroll.
// Two fingers: pinch to zoom and move around. The bar below types and presses keys.
export default function LiveScreen({ send, reply = '', children = null }) {
  const [src, setSrc] = useState('');
  const [mode, setMode] = useState('pictures'); // pictures at once (fast), video once it connects
  const video = useRef(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const firstReply = useRef(reply);
  const noteTimer = useRef(null);
  const [typing, setTyping] = useState(false); // typing by voice: the mic re-opens after each phrase
  const [answerAt, setAnswerAt] = useState(0);
  const landscape = useLandscape();
  // The Novi app can turn the view sideways (app 2.4.9+); back upright when the view closes.
  const canRotate = typeof window !== 'undefined' && typeof window.NoviApp?.rotate === 'function';
  const [sideways, setSideways] = useState(false);
  useEffect(() => () => { if (canRotate) window.NoviApp.rotate(false); }, [canRotate]);
  const rotate = () => { const next = !sideways; setSideways(next); window.NoviApp.rotate(next); };
  // Always listening while the view is open (user, 2026-11-08): the mic opens again after each phrase.
  // Three listens in a row that end at once (no mic, permission refused) turn it off instead of looping.
  const [listening, setListening] = useState(true);
  // The talk button opens the mic only when it is idle (not while it sends the last phrase), so it is
  // nudged every 0.7 s while listening is on.
  const listen = useRef({ startedAt: 0, quick: 0 });
  // The Novi app's own speech recognition (app 2.5.0): faster than recording + uploading, words show as you
  // speak. Without it, the talk button below is used.
  const [speechApp] = useState(() => phoneSpeech());
  const [hearing, setHearing] = useState('');
  useEffect(() => {
    if (!listening || !speechApp) return undefined;
    let alive = true;
    let n = 0;
    let current = '';
    let failures = 0;
    let timer = null;
    let watchdog = null;
    // A listen the app dropped (Novi went to the background and back) never reports: start a new one.
    const next = () => {
      if (!alive) return;
      current = `s${++n}`;
      clearTimeout(watchdog);
      watchdog = setTimeout(next, 12_000);
      speechApp.recognize(current);
    };
    const stop = onHeard((r) => {
      if (!alive || r.id !== current) return;
      if (!r.final) { setHearing(r.text); clearTimeout(watchdog); watchdog = setTimeout(next, 12_000); return; }
      clearTimeout(watchdog);
      setHearing('');
      if (r.text) { failures = 0; send({ type: 'user_message', text: r.text, voice: true }); }
      else if (r.error && r.error !== 'no speech' && r.error !== 'no match') {
        failures += 1;
        if (failures >= 3) { setListening(false); setNote(`Listening stopped (${r.error}). Tap the mic to try again.`); return; }
      }
      timer = setTimeout(next, r.text ? 150 : 300);
    });
    next();
    return () => { alive = false; clearTimeout(timer); clearTimeout(watchdog); stop(); setHearing(''); try { speechApp.stopRecognize?.(); } catch { /* gone */ } };
  }, [listening, speechApp, send]);
  useEffect(() => {
    if (!listening || speechApp) return undefined;
    const timer = setInterval(() => setAnswerAt(Date.now()), 700);
    return () => clearInterval(timer);
  }, [listening]);
  const onRecording = (on) => {
    const l = listen.current;
    if (on) { l.startedAt = Date.now(); return; }
    l.quick = Date.now() - l.startedAt < 800 ? l.quick + 1 : 0;
    if (l.quick >= 3) { l.quick = 0; setListening(false); setNote("The mic wouldn't stay on. Tap the mic to try again."); }
  };
  // A reply that arrives while the view is open (a voice step's answer) shows for a few seconds.
  useEffect(() => {
    if (!reply || reply === firstReply.current) return undefined;
    firstReply.current = null;
    setNote(reply);
    const t = setTimeout(() => setNote((n) => (n === reply ? '' : n)), 6000);
    return () => clearTimeout(t);
  }, [reply]);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const img = useRef(null);
  const fingers = useRef(new Map());
  const gesture = useRef(null);

  useEffect(() => {
    // Pictures from the first moment (user, 2026-11-08: "fast as we click"); the video takes over when it
    // connects, and the pictures come back if it drops.
    let pictures = true;
    let pc = null;
    const usePictures = () => {
      if (pictures) return;
      pictures = true;
      setMode('pictures');
      send({ type: 'live_ack' });
    };
    const stop = onLive(async (msg) => {
      // What Novi did ("Opened Spotify.") or asks: the view's line, gone after a few seconds.
      if (msg.type === 'live_note') {
        setNote(msg.text);
        clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setNote((n) => (n === msg.text ? '' : n)), 6000);
        return;
      }
      if (msg.type === 'live_stream_failed') { usePictures(); return; }
      if (msg.type === 'live_typing') { setTyping(msg.on); if (msg.on) setAnswerAt(msg.at || Date.now()); return; }
      if (msg.type === 'live_offer') {
        try {
          const r = await answerOffer(msg.sdp, {
            onTrack: (e) => {
              const v = video.current;
              if (!v) return;
              v.srcObject = e.streams?.[0] || new MediaStream([e.track]);
              v.play().catch(() => {});
            },
            onState: (state) => {
              if (state === 'connected') { pictures = false; setMode('video'); }
              if (state === 'failed' || state === 'disconnected') usePictures();
            },
          });
          pc = r.pc;
          send({ type: 'live_answer', sdp: r.sdp });
        } catch { usePictures(); }
        return;
      }
      if (!pictures) return;
      if (msg.type === 'live_frame') setSrc(`data:image/png;base64,${msg.png}`);
      send({ type: 'live_ack' }); // the next picture only after this one arrived: no pile-up on a slow link
    });
    send({ type: 'live_ack' });
    if (typeof RTCPeerConnection === 'function') send({ type: 'live_stream' });
    return () => { try { pc?.close(); } catch { /* gone */ } stop(); send({ type: 'live_stop' }); };
  }, [send]);

  const input = (m) => send({ type: 'live_input', ...m });

  const down = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...fingers.current.values()];
    if (pts.length === 1) {
      // Where the finger went down: the laptop scrolls the part under it (a side panel, not the middle).
      const shown = mode === 'video' ? video.current : img.current;
      const at = shown ? tapPoint(shown.getBoundingClientRect(), e.clientX, e.clientY) : null;
      gesture.current = { kind: 'one', x: e.clientX, y: e.clientY, sent: 0, moved: false, at };
    }
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
      if (notches) { g.sent += notches; input({ kind: 'scroll', notches, ...(g.at || {}) }); }
    }
  };

  const up = (e) => {
    fingers.current.delete(e.pointerId);
    const g = gesture.current;
    const shown = mode === 'video' ? video.current : img.current;
    if (g?.kind === 'one' && !g.moved && shown) {
      const point = tapPoint(shown.getBoundingClientRect(), e.clientX, e.clientY);
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#000', display: 'flex', flexDirection: landscape ? 'row' : 'column' }}>
      <div
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none' }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      >
        <video
          ref={video} muted playsInline autoPlay
          style={{ display: mode === 'video' ? 'block' : 'none', maxWidth: '100%', maxHeight: '100%', transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, userSelect: 'none' }}
        />
        {mode === 'video' ? null : src
          ? <img ref={img} src={src} alt="Laptop screen" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, userSelect: 'none' }} />
          : <span style={{ color: '#9aa8b6' }}>Connecting to the laptop…</span>}
      </div>
      <div style={landscape ? { width: 230, flexShrink: 0, overflowY: 'auto', background: '#0b1016', display: 'flex', flexDirection: 'column', paddingRight: 'env(safe-area-inset-right)' } : { display: 'contents' }}>
      {hearing && <div style={{ background: '#0f1a24', color: '#9fd4ff', padding: '6px 12px', fontSize: 14 }}>… {hearing}</div>}
      {typing && <div style={{ background: '#123a2a', color: '#7ff0b8', padding: '6px 12px', fontSize: 14 }}>Say it: your next words get typed. Say send to send.</div>}
      {note && <div style={{ background: '#3a2d12', color: '#f0c36a', padding: '8px 12px', fontSize: 14 }} onClick={() => setNote('')}>{note}</div>}
      <div style={landscape ? { ...bar, flexWrap: 'wrap' } : bar}>
        <input
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') typeIt(); }}
          placeholder="Type on the laptop" autoComplete="off" autoCorrect="off"
          style={{ flex: 1, minWidth: 0, background: '#1b2733', color: '#e6ecf2', border: 0, borderRadius: 8, padding: '10px 12px', fontSize: 16 }}
        />
        <button style={button} onClick={typeIt} aria-label="Type it"><Send size={18} /></button>
        <button style={{ ...button, background: typing ? '#123a2a' : '#1b2733' }} onClick={() => send({ type: 'user_message', text: 'type', voice: true })} aria-label="Type my next words">
          <Keyboard size={18} />Type
        </button>
        {canRotate && <button style={button} onClick={rotate} aria-label={sideways ? 'Turn upright' : 'Turn sideways'}><RotateCw size={18} /></button>}
        <button style={{ ...button, background: listening ? '#123a2a' : '#1b2733' }} onClick={() => { listen.current.quick = 0; setListening((v) => !v); }} aria-label={listening ? 'Stop listening' : 'Listen'}>
          {listening ? <Mic size={18} /> : <MicOff size={18} />}
        </button>
        {children && <div className="live-talk">{isValidElement(children) ? cloneElement(children, { answerAt, onRecording }) : children}</div>}
      </div>
      <div style={{ ...bar, paddingTop: 0, paddingBottom: 'max(8px, env(safe-area-inset-bottom))', flexWrap: 'wrap' }}>
        <button style={button} onClick={() => input({ kind: 'key', key: 'enter' })}><CornerDownLeft size={18} />Enter</button>
        <button style={button} onClick={() => input({ kind: 'key', key: 'backspace' })} aria-label="Backspace"><Delete size={18} /></button>
        <button style={button} onClick={() => input({ kind: 'key', key: 'alt+left' })}><ArrowLeft size={18} />Back</button>
        <button style={button} onClick={() => input({ kind: 'key', key: 'esc' })}>Esc</button>
        <button style={{ ...button, marginLeft: 'auto' }} onClick={() => send({ type: 'live_stop' })}><X size={18} />Close</button>
      </div>
      </div>
    </div>
  );
}

// Phone turned sideways: the screen gets the full height and the controls go to a column on the right.
function useLandscape() {
  const query = '(orientation: landscape) and (max-height: 600px)';
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return undefined;
    const change = () => setOn(m.matches);
    m.addEventListener?.('change', change);
    return () => m.removeEventListener?.('change', change);
  }, []);
  return Boolean(on);
}
