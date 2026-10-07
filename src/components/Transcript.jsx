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
          {e.text}
        </div>
      ))}
      {thinking && <div className="bubble novi thinking"><span /><span /><span /></div>}
      <div ref={end} />
    </div>
  );
}
