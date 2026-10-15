import { useEffect, useState } from 'react';

// Settings → History (laptop only): every command Novi was asked to run on the laptop — time,
// safety level, who asked, what it was for, the command, whether it worked, and what came back.
const LEVEL = { look: 'look', change: 'change', danger: 'needs PIN', never: 'refused' };
const time = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function CommandHistory({ api }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api('/api/commands/history').then((r) => r.json()).then((b) => setEntries(b.entries || [])).catch(() => setError('Could not load the history.'));
  }, [api]);

  if (error) return <p className="muted">{error}</p>;
  if (!entries) return <p className="muted">Loading…</p>;
  if (!entries.length) return <p className="muted">No commands yet. Ask Novi things like “how much space is left on D drive?”.</p>;
  return (
    <ul className="cmd-history">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <div className="cmd-head">
            <span className={`chip cmd-${e.level}`}>{LEVEL[e.level] || e.level}</span>
            <span className="muted">{time(e.at)} · {e.from}</span>
            <span aria-label={e.ran ? (e.ok ? 'worked' : 'failed') : 'not run'}>{e.ran ? (e.ok ? '✓' : '✗') : '–'}</span>
          </div>
          <strong>{e.purpose}</strong>
          <code>{e.command}</code>
          {e.output && (
            <details>
              <summary className="muted">Output</summary>
              <pre>{e.output}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
