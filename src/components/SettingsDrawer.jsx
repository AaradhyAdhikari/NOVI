import { useEffect, useState } from 'react';
import { X, Trash2 } from 'lucide-react';

export default function SettingsDrawer({ open, onClose, projects, devices, api, isLocal }) {
  const [pairing, setPairing] = useState(null);

  useEffect(() => {
    if (!open || !isLocal) return undefined;
    let cancelled = false;
    const load = () => api('/api/pairing-code').then((r) => r.json()).then((p) => !cancelled && setPairing(p)).catch(() => {});
    load();
    const timer = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, isLocal, api]);

  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Settings">
        <div className="drawer-head"><h2>Settings</h2><button className="icon" onClick={onClose} aria-label="Close"><X size={18} /></button></div>

        {isLocal && pairing && (
          <section>
            <h3>Pair a phone</h3>
            <p>On your phone (same Wi-Fi), open:</p>
            <ul className="urls">{pairing.urls.map((u) => <li key={u}><code>{u}</code></li>)}</ul>
            <p>Accept the certificate warning, then enter this code:</p>
            <div className="code">{pairing.code}</div>
          </section>
        )}

        <section>
          <h3>Projects Novi remembers</h3>
          {projects.length === 0 && <p className="muted">None yet. Say “Remember my portfolio project at C:\\path\\to\\folder”.</p>}
          <ul className="list">
            {projects.map((p) => (
              <li key={p.name}>
                <div><strong>{p.name}</strong><code>{p.path}</code></div>
                <button className="icon" aria-label={`Forget ${p.name}`} onClick={() => api(`/api/projects/${encodeURIComponent(p.name)}`, { method: 'DELETE' })}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3>Paired devices</h3>
          {devices.length === 0 && <p className="muted">No phones paired.</p>}
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id}>
                <div><strong>{d.name}</strong><span className="muted">{new Date(d.pairedAt).toLocaleString()}</span></div>
                <button className="icon" aria-label={`Remove ${d.name}`} onClick={() => api(`/api/devices/${d.id}`, { method: 'DELETE' })}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
