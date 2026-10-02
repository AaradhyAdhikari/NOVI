import { useRef, useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { startRecording, listenOnce, hasBrowserRecognition, stopSpeaking } from '../lib/voice.js';

export default function TalkButton({ onText, api }) {
  const [phase, setPhase] = useState('idle'); // idle | recording | transcribing
  const [error, setError] = useState(null);
  const [useBrowser, setUseBrowser] = useState(false);
  const stopRef = useRef(null);

  async function begin(e) {
    e.preventDefault();
    if (phase !== 'idle') return;
    stopSpeaking();
    setError(null);
    if (useBrowser) {
      setPhase('recording');
      try {
        const text = await listenOnce();
        if (text) onText(text);
      } catch (err) {
        setError(err.message);
      }
      setPhase('idle');
      return;
    }
    try {
      stopRef.current = await startRecording();
      setPhase('recording');
    } catch {
      setError('Microphone unavailable. On a phone, open Novi over https and allow the mic.');
    }
  }

  async function end(e) {
    e.preventDefault();
    if (phase !== 'recording' || useBrowser || !stopRef.current) return;
    setPhase('transcribing');
    const blob = await stopRef.current();
    stopRef.current = null;
    try {
      const res = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Speech-to-text failed');
      if (body.text) onText(body.text);
    } catch (err) {
      if (hasBrowserRecognition) {
        setUseBrowser(true);
        setError('Server speech-to-text failed; switched to browser recognition. Tap the button and speak.');
      } else {
        setError(`${err.message}. You can type instead.`);
      }
    }
    setPhase('idle');
  }

  return (
    <div className="talk">
      {error && <p className="error" role="alert">{error}</p>}
      <button
        className={`talk-btn ${phase}`}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerLeave={end}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={phase === 'recording' ? 'Release to send' : 'Hold to talk'}
      >
        {phase === 'transcribing' ? <Loader2 className="spin" size={34} /> : <Mic size={34} />}
      </button>
      <span className="talk-hint">{phase === 'recording' ? (useBrowser ? 'Listening…' : 'Release to send') : phase === 'transcribing' ? 'Understanding…' : useBrowser ? 'Tap to talk' : 'Hold to talk'}</span>
    </div>
  );
}
