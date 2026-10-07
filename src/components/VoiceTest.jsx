import { useEffect, useState } from 'react';
import { stopSpeaking } from '../lib/voice.js';

const LANG = { en: 'English', hi: 'Hindi', mr: 'Marathi', hinglish: 'Hinglish' };

// Settings → Voice test: record each test phrase once in your own voice. The clips stay on
// the laptop (data/voice-samples/) and are used to pick the best speech-to-text for you.
export default function VoiceTest({ api }) {
  const [phrases, setPhrases] = useState([]);
  const [recorded, setRecorded] = useState([]);
  const [index, setIndex] = useState(0);
  const [state, setState] = useState('idle'); // idle | listening | saving
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api('/api/voice-samples').then((r) => r.json()).then((body) => {
      setPhrases(body.phrases);
      setRecorded(body.recorded);
      const next = body.phrases.findIndex((p) => !body.recorded.includes(p.id));
      setIndex(next === -1 ? 0 : next);
    }).catch(() => setMsg('Could not load the test phrases.'));
  }, [api]);

  if (!phrases.length) return msg ? <p className="muted">{msg}</p> : null;
  const phrase = phrases[index];
  const nextIndex = () => {
    const after = phrases.findIndex((p, i) => i > index && !recorded.includes(p.id));
    return after === -1 ? (index + 1) % phrases.length : after;
  };

  async function save(blob) {
    if (!blob) {
      setMsg("I didn't hear anything. Tap Record and read the sentence.");
      setState('idle');
      return;
    }
    setState('saving');
    const res = await api(`/api/voice-samples/${phrase.id}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    if (res.ok) {
      setRecorded((r) => (r.includes(phrase.id) ? r : [...r, phrase.id]));
      setMsg('Saved.');
      setIndex(nextIndex());
    } else {
      setMsg((await res.json().catch(() => ({}))).error || 'Saving failed.');
    }
    setState('idle');
  }

  async function record() {
    stopSpeaking();
    setMsg(null);
    setState('listening');
    try {
      const { startVadRecording } = await import('../lib/vadRecorder.js');
      await startVadRecording({ mode: 'tap', onAutoDone: save });
    } catch {
      setMsg('Microphone or voice detection unavailable in this browser.');
      setState('idle');
    }
  }

  return (
    <div className="voice-test">
      <p className="muted">{recorded.length} of {phrases.length} recorded · {LANG[phrase.lang]}{recorded.includes(phrase.id) ? ' · done (record again to replace)' : ''}</p>
      <p className="voice-test-phrase"><strong>{phrase.text}</strong></p>
      <div className="row">
        <button className="btn primary" disabled={state !== 'idle'} onClick={record}>
          {state === 'listening' ? 'Listening… read it now' : state === 'saving' ? 'Saving…' : 'Record'}
        </button>
        <button className="btn" disabled={state !== 'idle'} onClick={() => { setMsg(null); setIndex(nextIndex()); }}>Skip</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
