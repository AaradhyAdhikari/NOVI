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
      {last !== null && <p className="muted">Last clip scored {last.toFixed(2)} (wakes at {info.threshold ?? '—'}).</p>}
      <p className="muted">{info.count} clip{info.count === 1 ? '' : 's'} saved in data/voice-samples/hey-novi.</p>
      {info.suggested !== null && info.suggested !== info.threshold && (
        <button className="btn" onClick={() => apply(info.suggested)}>Use level {info.suggested} (fits your voice)</button>
      )}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}
