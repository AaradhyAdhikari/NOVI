import { useEffect, useRef } from 'react';

export default function Transcript({ entries, thinking }) {
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [entries.length, thinking]);
  return (
    <div className="transcript" aria-live="polite">
      {entries.length === 0 && <p className="empty">Hold the button and say something like “Add a login page to my portfolio project.”</p>}
      {entries.map((e, i) => (
        <div key={`${e.at}-${i}`} className={`bubble ${e.role}`}>
          {e.image && <a href={e.image} target="_blank" rel="noreferrer"><img className="shot" src={e.image} alt={e.text || 'Screenshot'} /></a>}
          {e.video && (
            <iframe className="video" src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(e.video)}?autoplay=1&playsinline=1`}
              title={e.text || 'YouTube video'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
          )}
          {e.link ? <a className="open-link" href={e.link} target="_blank" rel="noreferrer">Open {e.text}</a> : e.text}
        </div>
      ))}
      {thinking && <div className="bubble novi thinking"><span /><span /><span /></div>}
      <div ref={end} />
    </div>
  );
}
