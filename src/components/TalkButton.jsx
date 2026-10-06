import { useRef, useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { startRecording, stopSpeaking } from '../lib/voice.js';

// Push-to-talk: always records and transcribes with Groq Whisper on the server.
// (Chrome's own recognizer is left to hands-free mode; two recognizers at once cancel each other.)
export default function TalkButton({ onText, api, onRecording = () => {}, handsFreeOn = false }) {
  const [phase, setPhase] = useState('idle'); // idle | starting | recording | transcribing
  const [error, setError] = useState(null);
  const stopRef = useRef(null);
  const releasedRef = useRef(false);

  async function begin(e) {
    e.preventDefault();
    if (phase !== 'idle') return;
    stopSpeaking();
    setError(null);
    releasedRef.current = false;
    setPhase('starting');
    onRecording(true);
    try {
      stopRef.current = await startRecording();
    } catch {
      onRecording(false);
      setPhase('idle');
      setError('Microphone unavailable. Allow the mic for this page (on a phone, open Novi over https).');
      return;
    }
    if (releasedRef.current) {
      // Let go before the mic was ready (e.g. while Chrome asked for permission): discard and reset.
      await stopRef.current();
      stopRef.current = null;
      onRecording(false);
      setPhase('idle');
      return;
    }
    setPhase('recording');
  }

  async function end(e) {
    e.preventDefault();
    releasedRef.current = true;
    if (phase !== 'recording' || !stopRef.current) return;
    setPhase('transcribing');
    const blob = await stopRef.current();
    stopRef.current = null;
    onRecording(false);
    try {
      const res = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `server error ${res.status}`);
      const text = String(body.text || '').trim();
      if (text && text !== '.') onText(text);
      else setError("I didn't catch that. Hold the button while you speak.");
    } catch (err) {
      setError(`Speech-to-text failed (${err.message}). Try again, or type.`);
    }
    setPhase('idle');
  }

  const hint = phase === 'starting' ? 'Starting mic…'
    : phase === 'recording' ? 'Release to send'
      : phase === 'transcribing' ? 'Understanding…'
        : handsFreeOn ? 'Hold to talk, or say “Hey Novi”' : 'Hold to talk';

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
      <span className="talk-hint">{hint}</span>
    </div>
  );
}
