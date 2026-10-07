import { useEffect, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { registerPasskey } from '../lib/passkey.js';

// Settings on a paired phone: turn on fingerprint / face confirmation for deletes and payments.
export default function PasskeySetup({ api }) {
  const [state, setState] = useState(null);
  const [message, setMessage] = useState(null);
  const load = () => api('/api/passkeys').then((r) => r.json()).then(setState).catch(() => {});
  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function setup() {
    setMessage(null);
    try {
      await registerPasskey(api);
      setMessage('Fingerprint / face is set up for this phone.');
    } catch (err) {
      setMessage(`Not set up: ${err.message}`);
    }
    load();
  }

  if (!state) return null;
  if (!state.available) return <p className="muted">Fingerprint / face confirmation works when Novi is opened through its Tailscale address.</p>;
  return (
    <div>
      <p className="muted">Deletes and payments approved from this phone need your fingerprint or face. {state.registered ? 'Set up on this phone.' : 'Not set up yet, so they wait until you are at the laptop.'}</p>
      <button className="btn" onClick={setup}><Fingerprint size={16} /> {state.registered ? 'Set up again' : 'Set up fingerprint / face'}</button>
      {message && <p className="muted">{message}</p>}
    </div>
  );
}
