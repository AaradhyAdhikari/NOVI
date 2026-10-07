import { useState } from 'react';
import { askLaptop, deviceName } from '../lib/pairing.js';

// Phone, not paired yet (and not recognised through Tailscale): scan the QR on the laptop, or
// ask the laptop to let this phone in. No codes to type.
export default function PairScreen({ onAdopt, checking }) {
  const [state, setState] = useState('idle'); // idle | asking | waiting
  const [error, setError] = useState(null);

  async function ask() {
    setError(null);
    setState('asking');
    try {
      onAdopt(await askLaptop(deviceName(navigator.userAgent), { onWaiting: () => setState('waiting') }));
    } catch (err) {
      setError(err.message);
      setState('idle');
    }
  }

  return (
    <div className="pair">
      <div className="orb" aria-hidden />
      <h1>Connect to Novi</h1>
      {checking ? <p>Connecting…</p> : (
        <>
          <p>On the laptop, open Settings → <strong>Pair a phone</strong> and scan the QR code with this phone's camera.</p>
          <p className="muted">Or:</p>
          <button className="btn primary" onClick={ask} disabled={state !== 'idle'}>
            {state === 'waiting' ? 'Waiting for the laptop… tap Allow there' : state === 'asking' ? 'Asking…' : 'Ask the laptop to let me in'}
          </button>
          <p className="muted">Tip: with Tailscale on this phone (same account as the laptop), Novi connects by itself.</p>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
