import { useEffect, useRef, useState } from 'react';
import CodeCard from './CodeCard.jsx';
import { linkLabel } from '../lib/transcript.js';

export default function Transcript({ entries, thinking, codeSaved = {}, onCodeSave = () => {} }) {
  const end = useRef(null);
  const [viewing, setViewing] = useState(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [entries.length, thinking]);
  return (
    <div className="transcript" aria-live="polite">
      {entries.length === 0 && <p className="empty">Hold the button and say something like “Add a login page to my portfolio project.”</p>}
      {entries.map((e, i) => (
        <div key={`${e.at}-${i}`} className={`bubble ${e.role}${e.code ? ' wide' : ''}`}>
          {/* Pictures are data: URLs, which phone browsers refuse to open in a new tab (an empty black
              page, 2026-10-17): tapping opens them full-screen inside Novi instead. */}
          {e.image && <button type="button" className="shot-button" onClick={() => setViewing(e)} aria-label={`Open ${e.text || 'picture'} full screen`}><img className="shot" src={e.image} alt={e.text || 'Screenshot'} /></button>}
          {e.video && (
            <iframe className="video" src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(e.video)}?autoplay=1&playsinline=1`}
              title={e.text || 'YouTube video'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
          )}
          {e.code ? <CodeCard code={e.code} caption={e.text} saved={codeSaved[e.code.id]} onSave={onCodeSave} />
            : e.link ? <a className="open-link" href={e.link} target="_blank" rel="noreferrer">{linkLabel(e.text)}</a> : e.text}
        </div>
      ))}
      {thinking && <div className="bubble novi thinking"><span /><span /><span /></div>}
      {viewing && (
        <div className="viewer" role="dialog" aria-label={viewing.text || 'Picture'} onClick={() => setViewing(null)}>
          <img src={viewing.image} alt={viewing.text || 'Picture'} />
          <button type="button" className="viewer-close" onClick={() => setViewing(null)}>Close</button>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
