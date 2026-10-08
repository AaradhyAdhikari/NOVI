import { useEffect, useState } from 'react';

const ago = (iso) => {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};
const uptime = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

// Settings → System: is Novi healthy? Restart it, or copy diagnostics to share when something breaks.
const VOICE_CHECK = {
  on: 'only your voice wakes Novi',
  off: 'off (Settings → “Hey Novi” → Learn my voice)',
  'no-model': 'speaker model missing (see README → Voice check)',
  error: 'speaker model failed to load (see the log)',
  relearn: 'learn your voice again (the speaker model changed)',
};

export default function SystemPanel({ api }) {
  const [health, setHealth] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api('/api/health').then((r) => r.json()).then((h) => !cancelled && setHealth(h)).catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api]);

  if (!health) return <p className="muted">Loading…</p>;

  async function restart() {
    if (!window.confirm('Restart Novi? It will be back in a few seconds.')) return;
    const res = await api('/api/restart', { method: 'POST' });
    setMsg(res.ok ? 'Restarting… this page reconnects by itself.' : (await res.json().catch(() => ({}))).error || 'Restart failed.');
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(health, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setMsg('Diagnostics copied. Paste them to Claude or into an issue.');
    } catch {
      setMsg('Copy failed (the clipboard needs https and focus).');
    }
  }

  const providers = health.providers.map((p) => `${p.name}${p.healthy ? '' : ' (cooling down)'}`).join(', ') || 'none';
  return (
    <div className="system">
      <ul className="list">
        <li><div><strong>Version</strong><span className="muted">{health.version}</span></div></li>
        <li><div><strong>Running for</strong><span className="muted">{uptime(health.uptimeSec)}{health.supervised ? `, ${health.restarts} automatic restart${health.restarts === 1 ? '' : 's'}` : ' (not supervised: start with Start Novi.cmd to auto-restart)'}</span></div></li>
        <li><div><strong>AI providers</strong><span className="muted">{providers}</span></div></li>
        <li><div><strong>“Hey Novi”</strong><span className="muted">{health.wakeWord === 'server' ? 'laptop microphone (always on)' : 'this browser'}</span></div></li>
        <li><div><strong>Voice check</strong><span className="muted">{VOICE_CHECK[health.speakerCheck] || 'off'}</span></div></li>
        <li><div><strong>Last backup</strong><span className="muted">{health.lastBackup ? `${ago(health.lastBackup.at)} (${health.lastBackup.file})` : 'none yet'}</span></div></li>
      </ul>
      {health.errors.length > 0 && (
        <details>
          <summary className="muted">{health.errors.length} recent warning{health.errors.length === 1 ? '' : 's'}/error{health.errors.length === 1 ? '' : 's'}</summary>
          <ul className="list">
            {health.errors.slice().reverse().map((e) => (
              <li key={`${e.at}${e.text}`}><div><strong>{e.level}</strong><span className="muted">{new Date(e.at).toLocaleString()} — {e.text.slice(0, 300)}</span></div></li>
            ))}
          </ul>
        </details>
      )}
      <div className="row">
        <button className="btn" onClick={restart} disabled={!health.supervised}>Restart Novi</button>
        <button className="btn" onClick={copyDiagnostics}>Copy diagnostics</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
