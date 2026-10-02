import { useState } from 'react';

export default function PairScreen({ onPair }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(await onPair(code.trim(), navigator.userAgent.includes('Mobile') ? 'Phone' : 'Browser'));
    setBusy(false);
  }

  return (
    <div className="pair">
      <div className="orb" aria-hidden />
      <h1>Pair with Novi</h1>
      <p>Enter the 6-digit code shown on your laptop (Settings → Pair a phone).</p>
      <form onSubmit={submit}>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Pairing code" />
        <button className="btn primary" disabled={code.length !== 6 || busy}>Pair</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
