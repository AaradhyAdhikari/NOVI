import { useEffect, useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';

// Settings → "Hey Novi" (laptop only): record practice clips through the same microphone the
// always-on wake word uses. Each clip is scored by the current model; after 10+ clips Novi
// suggests a trigger level from your own voice. The clips are also for retraining the model.
const TIPS = ['normal', 'quietly', 'quickly', 'from a bit further away', 'with some background noise', 'the way you say it when tired', 'a little louder'];

export default function WakeTraining({ api }) {
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | recording
  const [last, setLast] = useState(null);
  const [error, setError] = useState(null);
  const [match, setMatch] = useState(null);
  const load = () => api('/api/wake-samples').then((r) => r.json()).then(setInfo).catch(() => {});
  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function record() {
    setError(null);
    setPhase('recording');
    try {
      const res = await api('/api/wake-samples', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setLast(body.score);
      setMatch(body.voiceMatch ?? null);
    } catch (err) {
      setError(err.message);
    }
    setPhase('idle');
    load();
  }

  async function apply(threshold) {
    await api('/api/wake-samples/threshold', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threshold }) });
    load();
  }

  if (!info) return null;
  if (!info.available) return <p className="muted">The always-on “Hey Novi” isn't running on this laptop, so clips can't be recorded.</p>;
  const tip = TIPS[info.count % TIPS.length];
  return (
    <div>
      <p className="muted">Press the button, then say <strong>“Hey Novi”</strong> once ({tip}). It records with the same microphone Novi listens on, so stand or sit where you usually talk to it. Aim for 30 clips.</p>
      <button className="btn primary" onClick={record} disabled={phase !== 'idle'}>
        {phase === 'recording' ? <Loader2 size={16} className="spin" /> : <Mic size={16} />}
        {phase === 'recording' ? ' Say “Hey Novi” now…' : ` Record clip ${info.count + 1}`}
      </button>
      {last !== null && <p className="muted">Last clip scored {last.toFixed(2)} (wakes at {info.threshold ?? '—'}){match !== null && `, voice match ${match.toFixed(2)}`}.</p>}
      <p className="muted">{info.count} clip{info.count === 1 ? '' : 's'} saved in data/voice-samples/hey-novi.</p>
      {info.suggested !== null && info.suggested !== info.threshold && (
        <button className="btn" onClick={() => apply(info.suggested)}>Use level {info.suggested} (fits your voice)</button>
      )}
      {error && <p className="warn">{error}</p>}
      <VoiceCheck api={api} clips={info.count} />
    </div>
  );
}

// "Only my voice": learn a voiceprint from the clips above; then only your voice wakes Novi, and
// saying "Hey Novi" while it talks stops it.
function VoiceCheck({ api, clips }) {
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [strictness, setStrictness] = useState(null);
  const show = (body) => { setV(body); setStrictness(body.strictness); };
  const load = () => api('/api/voiceprint').then((r) => r.json()).then(show).catch(() => {});
  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(url, method, body) {
    setError(null);
    setBusy(true);
    try {
      const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      show(data);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  if (!v) return null;
  return (
    <div className="voice-check">
      <h4>Only my voice</h4>
      {v.status !== 'ready' ? (
        <p className="muted">{v.status === 'error' ? 'The speaker model failed to load (see the log).' : 'Voice check needs the speaker model — see README (Voice check).'}</p>
      ) : (
        <>
          <p className="muted">Novi learns your voice from the clips above (at least 5). Then a TV or someone else saying “Hey Novi” is ignored, and you can say “Hey Novi” while it talks to stop it.</p>
          <button className="btn" onClick={() => send('/api/voiceprint/learn', 'POST')} disabled={busy || clips < 5}>
            {busy ? <Loader2 size={16} className="spin" /> : null} {v.learned ? 'Learn my voice again' : 'Learn my voice'}
          </button>
          {v.check === 'relearn' && <p className="warn">The speaker model changed: learn your voice again.</p>}
          {v.learned && (
            <>
              <p className="muted">Learned from {v.clipCount} clips · your match {v.selfScores[0].toFixed(2)}–{v.selfScores[1].toFixed(2)} · strictness {v.strictness}</p>
              <label className="row">
                <input type="checkbox" checked={v.enabled} onChange={(e) => send('/api/voiceprint', 'PUT', { enabled: e.target.checked })} /> Only my voice wakes Novi
              </label>
              <label className="row">
                Strictness {strictness?.toFixed(2)}
                <input type="range" min="0.1" max="0.9" step="0.01" value={strictness ?? 0.5}
                  onChange={(e) => setStrictness(Number(e.target.value))}
                  onPointerUp={() => send('/api/voiceprint', 'PUT', { strictness })}
                  onKeyUp={() => send('/api/voiceprint', 'PUT', { strictness })} />
              </label>
              <p className="muted">Higher = stricter. If Novi ignores you, lower it a little.</p>
            </>
          )}
        </>
      )}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}
