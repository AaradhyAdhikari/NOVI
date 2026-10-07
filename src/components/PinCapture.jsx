import { useEffect, useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';

// Phone: say the voice PIN for a high-risk approval. The words go to speech-to-text and straight
// back to the server inside the approval answer — never into the chat. A typed box only appears
// when Settings → Permissions allows typed PINs.
export default function PinCapture({ api, onPin }) {
  const [phase, setPhase] = useState('idle'); // idle | listening | checking
  const [error, setError] = useState(null);
  const [typedAllowed, setTypedAllowed] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    api('/api/remote-pin').then((r) => r.json()).then((s) => setTypedAllowed(s.pinInput === 'voice-or-typed')).catch(() => {});
  }, [api]);

  async function listen() {
    setError(null);
    setPhase('listening');
    try {
      const { startVadRecording } = await import('../lib/vadRecorder.js');
      await startVadRecording({
        mode: 'tap',
        onAutoDone: async (blob) => {
          if (!blob) { setError("I didn't hear a PIN. Try again."); setPhase('idle'); return; }
          setPhase('checking');
          try {
            const res = await api('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/wav' }, body: blob });
            const { text } = await res.json();
            onPin({ pinSpoken: String(text || '') });
          } catch {
            setError('Speech-to-text failed. Try again.');
          }
          setPhase('idle');
        },
      });
    } catch {
      setError("Couldn't open the microphone.");
      setPhase('idle');
    }
  }

  return (
    <div className="pin-capture">
      <button className="btn danger" onClick={listen} disabled={phase !== 'idle'}>
        {phase === 'idle' ? <Mic size={16} /> : <Loader2 size={16} className="spin" />}
        {phase === 'listening' ? ' Listening…' : phase === 'checking' ? ' Checking…' : ' Say PIN'}
      </button>
      {typedAllowed && (
        <form onSubmit={(e) => { e.preventDefault(); onPin({ pinTyped: typed }); setTyped(''); }}>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="or type PIN" aria-label="PIN" />
        </form>
      )}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}
