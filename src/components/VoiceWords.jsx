import { useEffect, useState } from 'react';

// Settings → Words (laptop only): your word list (names Novi should expect + "if I hear X, it
// means Y" fixes) and the last voice commands, each with a "Wrong" button. A wrong one is saved
// with what you really said for the speech benchmark, and a suggested fix can be added in one tap.
const toText = (fixes) => Object.entries(fixes).map(([from, to]) => `${from} = ${to}`).join('\n');
const fromText = (text) => Object.fromEntries(text.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2).map(([a, b]) => [a.trim(), b.trim()]).filter(([a, b]) => a && b));

export default function VoiceWords({ api }) {
  const [words, setWords] = useState('');
  const [fixes, setFixes] = useState('');
  const [log, setLog] = useState([]);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [fixing, setFixing] = useState(null); // { id, said }
  const [suggestion, setSuggestion] = useState(null);

  const show = (v) => { setWords(v.words.join(', ')); setFixes(toText(v.fixes)); };
  const loadLog = () => api('/api/voice-log').then((r) => r.json()).then((b) => setLog(b.entries || [])).catch(() => {});
  useEffect(() => {
    api('/api/vocabulary').then((r) => r.json()).then(show).catch(() => {});
    loadLog();
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function call(url, method, body) {
    setError(null);
    const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  }
  const run = (fn) => fn().catch((err) => setError(err.message));

  const save = () => run(async () => {
    show(await call('/api/vocabulary', 'PUT', { words: words.split(',').map((w) => w.trim()).filter(Boolean), fixes: fromText(fixes) }));
    setNote('Saved.');
  });
  const markWrong = () => run(async () => {
    const result = await call(`/api/voice-log/${fixing.id}/wrong`, 'POST', { said: fixing.said });
    setNote(result.saved ? 'Saved for the speech test.' : 'Noted (the recording was already gone).');
    setSuggestion(result.suggestion);
    setFixing(null);
    loadLog();
  });
  const addFix = () => run(async () => {
    show(await call('/api/vocabulary/fix', 'POST', suggestion));
    setNote(`Added: ${suggestion.from} = ${suggestion.to}`);
    setSuggestion(null);
  });

  return (
    <div className="voice-words">
      <label className="muted">Names Novi should expect (comma-separated): people, projects, apps, places</label>
      <input aria-label="Names Novi should expect" value={words} onChange={(e) => setWords(e.target.value)} placeholder="Aaradhy, OpenClaw, LeetCode" />
      <label className="muted">Fixes, one per line: what Novi hears = what you meant</label>
      <textarea aria-label="Fixes" rows={4} value={fixes} onChange={(e) => setFixes(e.target.value)} placeholder={'open claw = OpenClaw\nnovee = Novi'} />
      <button className="btn" onClick={save}>Save words</button>
      {suggestion && (
        <p className="muted">
          Fix “{suggestion.from}” → “{suggestion.to}” from now on? <button className="btn" onClick={addFix}>Add fix</button>
        </p>
      )}
      {note && <p className="muted">{note}</p>}
      {error && <p className="warn">{error}</p>}
      <h4>What Novi heard recently</h4>
      {log.length === 0 && <p className="muted">Nothing yet — talk to Novi and your commands show up here.</p>}
      <ul className="list">
        {log.map((e) => (
          <li key={e.id}>
            <div>
              <strong>{e.text}</strong>
              {e.heard !== e.text && <span className="muted"> (heard “{e.heard}”)</span>}
              {e.reply && <span className="muted"> → {e.reply.slice(0, 80)}</span>}
              {e.wrong && <span className="muted"> · you said “{e.said}”</span>}
            </div>
            {!e.wrong && fixing?.id !== e.id && <button className="btn" onClick={() => setFixing({ id: e.id, said: e.text })}>Wrong</button>}
            {fixing?.id === e.id && (
              <div>
                <input aria-label="What you actually said" value={fixing.said} onChange={(ev) => setFixing({ ...fixing, said: ev.target.value })} placeholder="What you actually said" />
                <button className="btn primary" onClick={markWrong}>Save</button>
                <button className="btn" onClick={() => setFixing(null)}>Cancel</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
