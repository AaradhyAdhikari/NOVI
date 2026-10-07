import { useEffect, useRef, useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { startRecording, stopSpeaking } from '../lib/voice.js';

// VAD (with its model runtime) is a big chunk: load it in the background after the page opens.
let vadModule = null;
const loadVad = () => (vadModule ||= import('../lib/vadRecorder.js'));

const TAP_MS = 350; // released faster than this = a tap: keep listening until you stop talking

// Talk button: hold while speaking, or tap once and Novi stops listening when you pause.
// Silero VAD keeps only real speech, so silence is never sent to speech-to-text.
// Falls back to a plain recorder if VAD can't load. Transcription is on the server.
// (Chrome's own recognizer is left to hands-free mode; two recognizers at once cancel each other.)
export default function TalkButton({ onText, api, onRecording = () => {}, handsFreeOn = false }) {
  const [phase, setPhase] = useState('idle'); // idle | starting | recording | listening | transcribing
  const [error, setError] = useState(null);
  const recRef = useRef(null); // { finish(): Promise<Blob|null>, switchToTap?() }
  const pressedAtRef = useRef(0);
  const releasedRef = useRef(false);
  const phaseRef = useRef('idle');
  const go = (p) => { phaseRef.current = p; setPhase(p); };
  // Load the speech detector model as soon as the page opens (no mic yet), so the first tap is quick.
  useEffect(() => { loadVad().then((m) => m.warmVad()).catch(() => {}); }, []);
  const micOpenMsRef = useRef(0);

  async function send(blob) {
    recRef.current = null;
    onRecording(false);
    if (!blob) {
      setError("I didn't hear any speech. Try again a little louder.");
      go('idle');
      return;
    }
    go('transcribing');
    try {
      const res = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Novi-Mic-Ms': String(micOpenMsRef.current) }, body: blob });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `server error ${res.status}`);
      const text = String(body.text || '').trim();
      if (text && text !== '.') onText(text);
      else setError("I didn't catch that. Try again, or type.");
    } catch (err) {
      setError(`Speech-to-text failed (${err.message}). Try again, or type.`);
    }
    go('idle');
  }

  async function open() {
    try {
      const { startVadRecording } = await loadVad();
      return await startVadRecording({ mode: 'hold', onAutoDone: (blob) => { if (phaseRef.current === 'listening') send(blob); } });
    } catch (err) {
      console.warn('[voice] VAD unavailable, using plain recording:', err);
      const stop = await startRecording();
      return { finish: stop };
    }
  }

  async function begin(e) {
    e.preventDefault();
    if (phaseRef.current === 'listening') return finishNow(); // second tap = done
    if (phaseRef.current !== 'idle') return;
    stopSpeaking();
    setError(null);
    releasedRef.current = false;
    pressedAtRef.current = Date.now();
    go('starting');
    onRecording(true);
    try {
      recRef.current = await open();
      micOpenMsRef.current = Date.now() - pressedAtRef.current;
    } catch {
      onRecording(false);
      go('idle');
      setError('Microphone unavailable. Allow the mic for this page (on a phone, open Novi over https).');
      return;
    }
    if (releasedRef.current) {
      // Released while the mic was starting (e.g. permission prompt): treat it as a tap.
      startListening();
      return;
    }
    go('recording');
  }

  function startListening() {
    if (!recRef.current?.switchToTap) {
      // Plain recorder can't tell when you stop talking: discard.
      recRef.current?.finish();
      recRef.current = null;
      onRecording(false);
      go('idle');
      return;
    }
    go('listening');
    recRef.current.switchToTap();
  }

  async function finishNow() {
    const rec = recRef.current;
    if (!rec) return;
    go('transcribing');
    send(await rec.finish());
  }

  function end(e) {
    e.preventDefault();
    releasedRef.current = true;
    if (phaseRef.current !== 'recording' || !recRef.current) return;
    if (Date.now() - pressedAtRef.current < TAP_MS) startListening();
    else finishNow();
  }

  const hint = phase === 'starting' ? 'Starting mic…'
    : phase === 'recording' ? 'Release to send'
      : phase === 'listening' ? 'Listening… I’ll stop when you pause (tap to finish)'
        : phase === 'transcribing' ? 'Understanding…'
          : handsFreeOn ? 'Tap or hold to talk, or say “Hey Novi”' : 'Tap or hold to talk';

  return (
    <div className="talk">
      {error && <p className="error" role="alert">{error}</p>}
      <button
        className={`talk-btn ${phase === 'listening' ? 'recording' : phase}`}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerLeave={end}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={phase === 'recording' ? 'Release to send' : phase === 'listening' ? 'Tap to finish' : 'Tap or hold to talk'}
      >
        {phase === 'transcribing' ? <Loader2 className="spin" size={34} /> : <Mic size={34} />}
      </button>
      <span className="talk-hint">{hint}</span>
    </div>
  );
}
