import { useEffect, useState } from 'react';

// Settings → Activity (laptop only): what happened in each request — what Novi heard, which way
// it went (fast command, direct tool, or the AI), the tools it ran (✓ / ✗ with the error) and the reply.
const time = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function ActivityLog({ api }) {
  const [entries, setEntries] = useState(null);
  const [mistakes, setMistakes] = useState({ list: [], summary: '' });
  const [error, setError] = useState(null);
  useEffect(() => {
    api('/api/activity').then((r) => r.json()).then((b) => { setEntries(b.entries || []); setMistakes({ list: b.mistakes || [], summary: b.summary || '' }); }).catch(() => setError('Could not load the activity.'));
  }, [api]);

  if (error) return <p className="muted">{error}</p>;
  if (!entries) return <p className="muted">Loading…</p>;
  if (!entries.length) return <p className="muted">Nothing yet. Every request will show here, with what went right or wrong.</p>;
  return (
    <>
    {mistakes.list.length > 0 && (
      <div className="mistakes">
        <h4>Mistakes Novi noticed</h4>
        <p className="muted">{mistakes.summary}</p>
        <ul className="cmd-history">
          {mistakes.list.map((m, i) => (
            <li key={`${m.at}-m${i}`}>
              <div className="cmd-head">
                <span className={`chip ${m.learned ? 'cmd-look' : 'cmd-danger'}`}>{m.learned ? 'learned' : m.fixedBy ? 'fixed later' : m.why}</span>
                <span className="muted">{time(m.at)}</span>
              </div>
              <strong>“{m.heard}”</strong>
              <div className="muted">{m.reply}</div>
              {m.said && <div>You said: “{m.said}”</div>}
              {m.error && <div className="warn">✗ {m.error}</div>}
            </li>
          ))}
        </ul>
        <h4>Every request</h4>
      </div>
    )}
    <ul className="cmd-history">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <div className="cmd-head">
            <span className={`chip ${e.route === 'failed' || e.tools.some((t) => !t.ok) ? 'cmd-danger' : 'cmd-look'}`}>{e.route}</span>
            <span className="muted">{time(e.at)} · {e.from} · {(e.ms / 1000).toFixed(1)} s</span>
          </div>
          <strong>“{e.heard}”</strong>
          {e.tools.map((t, j) => (
            <div key={j} className="muted">{t.ok ? '✓' : '✗'} {t.name}{t.ok ? '' : `: ${t.error}`} <small>({t.ms} ms)</small></div>
          ))}
          {e.error && <div className="warn">✗ {e.error}</div>}
          {e.reply && <div>{e.reply}</div>}
        </li>
      ))}
    </ul>
    </>
  );
}
