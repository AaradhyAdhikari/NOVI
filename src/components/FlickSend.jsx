import { useEffect, useRef, useState } from 'react';
import { X, ImagePlus, Link2, ArrowUp } from 'lucide-react';
import { isFlick, flickRequest, itemKind, createFlickDetector, motionSample } from '../lib/flickGesture.js';

// Novi Flick, phone side (2026-11-16): pick photos/files or paste a link, then flick the card up and it
// lands on the laptop's stage. One card at a time, the rest wait underneath.
// v2: the real flick: flick the phone itself toward the laptop (wrist flick) and the top card goes. In the Novi app the
// app's own sensors spot it and call window.__noviFlick (the same gesture works anywhere on the phone); in a
// browser the page listens to the motion sensors itself. The swipe up stays as a backup.
const ICON = { doc: '📄', file: '📦', link: '🔗', video: '▶️' };
let seq = 0;

export default function FlickSend({ api, onClose }) {
  const [queue, setQueue] = useState([]); // [{ id, file?, link?, name, kind, preview? }]
  const [status, setStatus] = useState('');
  const [linkText, setLinkText] = useState('');
  const [drag, setDrag] = useState({ dy: 0, flying: false });
  const start = useRef(null);
  const picker = useRef(null);
  const top = queue[0];

  const add = (items) => setQueue((q) => [...q, ...items]);
  // Things shared to the Novi app from Android's share menu ("Flick to Novi"): read once, then flicked like picked files.
  useEffect(() => {
    let list = [];
    try { list = JSON.parse(window.NoviApp?.flickInbox?.() || '[]'); } catch { list = []; }
    for (const it of list) {
      if (it.link) { add([{ id: ++seq, link: it.link, name: it.link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60), kind: 'link' }]); continue; }
      fetch(`https://novi-flick.local/${encodeURIComponent(it.id)}`).then((r) => (r.ok ? r.blob() : null)).then((blob) => {
        if (!blob) return;
        const file = new File([blob], it.name || 'file', { type: it.type || blob.type });
        const kind = itemKind({ file });
        add([{ id: ++seq, file, name: file.name, kind, preview: kind === 'photo' || kind === 'video' ? URL.createObjectURL(file) : null }]);
      }).catch(() => {});
    }
  }, []);
  const pick = (e) => {
    const files = [...(e.target.files || [])];
    add(files.map((file) => {
      const kind = itemKind({ file });
      return { id: ++seq, file, name: file.name, kind, preview: kind === 'photo' || kind === 'video' ? URL.createObjectURL(file) : null };
    }));
    e.target.value = '';
  };
  const addLink = () => {
    const link = linkText.trim();
    if (!/^https?:\/\//i.test(link)) { setStatus('Paste a link that starts with http.'); return; }
    add([{ id: ++seq, link, name: link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60), kind: 'link' }]);
    setLinkText('');
  };

  const send = async (item) => {
    setStatus(`Sending ${item.name}…`);
    try {
      const { url, init } = flickRequest(item);
      const res = await api(url, init);
      const out = await res.json().catch(() => ({}));
      setStatus(res.ok && out.ok !== false ? `${item.name} landed on the laptop.` : (out.error || 'The laptop didn’t take it.'));
    } catch { setStatus('Couldn’t reach the laptop.'); }
    finally { if (item.preview) setTimeout(() => URL.revokeObjectURL(item.preview), 2000); }
  };

  const down = (e) => { if (!top || drag.flying) return; start.current = { y: e.clientY, t: performance.now() }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = (e) => { if (start.current) setDrag({ dy: Math.min(40, e.clientY - start.current.y), flying: false }); };
  const flying = useRef(false);
  const flyAway = () => {
    const item = topRef.current;
    if (!item || flying.current) return false;
    flying.current = true;
    navigator.vibrate?.(25);
    setDrag({ dy: 0, flying: true });
    setTimeout(() => { setQueue((q) => q.slice(1)); setDrag({ dy: 0, flying: false }); flying.current = false; }, 420);
    send(item);
    return true;
  };
  const up = (e) => {
    if (!start.current) return;
    const dy = e.clientY - start.current.y, ms = performance.now() - start.current.t;
    start.current = null;
    if (!isFlick({ dy, ms })) { setDrag({ dy: 0, flying: false }); return; }
    flyAway();
  };
  const topRef = useRef(null);
  topRef.current = top;
  const flyRef = useRef(flyAway);
  flyRef.current = flyAway;
  const [motion, setMotion] = useState(window.NoviApp ? 'app' : typeof DeviceMotionEvent === 'undefined' ? 'none' : typeof DeviceMotionEvent.requestPermission === 'function' ? 'ask' : 'on');
  // The app's sensors (any screen) call this; it says whether a card went (else the app sends what's on screen).
  useEffect(() => {
    window.__noviFlick = () => flyRef.current();
    return () => { delete window.__noviFlick; };
  }, []);
  // In a browser: the motion sensors here.
  useEffect(() => {
    if (motion !== 'on') return undefined;
    const d = createFlickDetector();
    const on = (e) => { if (d.feed(motionSample(e))) flyRef.current(); };
    window.addEventListener('devicemotion', on);
    return () => window.removeEventListener('devicemotion', on);
  }, [motion]);
  const askMotion = async () => { try { setMotion((await DeviceMotionEvent.requestPermission()) === 'granted' ? 'on' : 'none'); } catch { setMotion('none'); } };

  const style = drag.flying
    ? { transform: 'translateY(-115vh) rotate(-8deg) scale(.6)', opacity: 0, transition: 'transform .42s cubic-bezier(.3,.7,.2,1), opacity .42s' }
    : { transform: `translateY(${drag.dy}px) rotate(${drag.dy / 30}deg)`, transition: start.current ? 'none' : 'transform .3s' };

  return (
    <div className="flick">
      <div className="flick-grid" />
      <div className="flick-head">
        <span>Flick to laptop</span>
        <button className="icon" onClick={onClose} aria-label="Close"><X size={20} /></button>
      </div>
      <div className="flick-area">
        {queue[1] && <div className="flick-card under" aria-hidden="true" />}
        {top ? (
          <div className="flick-card" style={style} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; setDrag({ dy: 0, flying: false }); }}>
            {top.kind === 'photo' && <img src={top.preview} alt={top.name} draggable="false" />}
            {top.kind === 'video' && <video src={top.preview} muted autoPlay loop playsInline />}
            {top.kind !== 'photo' && top.kind !== 'video' && <div className="flick-icon">{ICON[top.kind] || '📦'}</div>}
            <div className="flick-name">{top.name}</div>
            <div className="flick-hint"><ArrowUp size={14} /> {motion === 'app' || motion === 'on' ? 'Flick your phone toward the laptop, or swipe up' : 'Give it a little flick'}</div>
          </div>
        ) : (
          <div className="flick-empty">Pick photos or files, or paste a link.</div>
        )}
      </div>
      {queue.length > 1 && <div className="flick-more">{queue.length - 1} more waiting</div>}
      <div className="flick-status" aria-live="polite">{status}</div>
      {motion === 'ask' && <button className="flick-btn" onClick={askMotion}>Turn on the wrist flick</button>}
      <div className="flick-tools">
        <input ref={picker} type="file" multiple hidden onChange={pick} />
        <button className="flick-btn" onClick={() => picker.current?.click()}><ImagePlus size={18} /> Photos & files</button>
        <div className="flick-link">
          <input value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder="Paste a link" inputMode="url" onKeyDown={(e) => e.key === 'Enter' && addLink()} />
          <button className="flick-btn" onClick={addLink} aria-label="Add link"><Link2 size={18} /></button>
        </div>
      </div>
    </div>
  );
}
