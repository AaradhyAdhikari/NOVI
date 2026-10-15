import { useEffect, useState } from 'react';

// Settings → Browser (laptop only): is the Novi Chrome extension connected, its pairing code
// (Copy / New code) and the steps to install it.
export default function BrowserSetup({ api }) {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  const load = () => api('/api/browser').then((r) => r.json()).then(setInfo).catch(() => setInfo({ error: true }));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return <p className="muted">Loading…</p>;
  if (info.error) return <p className="muted">Could not load the browser status.</p>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(info.code || ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* copy by hand */ }
  };
  const fresh = () => api('/api/browser/code', { method: 'POST' }).then((r) => r.json()).then(setInfo);
  return (
    <div className="browser-setup">
      <p>{info.connected ? '✓ Chrome is connected.' : 'Chrome is not connected yet.'}</p>
      {info.code && (
        <p>
          Pairing code: <code>{info.code}</code>{' '}
          <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>{' '}
          <button onClick={fresh}>New code</button>
        </p>
      )}
      <ol className="muted">
        <li>In Chrome, open <code>chrome://extensions</code> and turn on Developer mode.</li>
        <li>Click “Load unpacked” and pick the <code>extension</code> folder inside Novi’s folder.</li>
        <li>Click the Novi icon in Chrome’s toolbar.</li>
        <li>Paste the pairing code there and save.</li>
      </ol>
    </div>
  );
}
