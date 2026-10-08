import { useEffect, useState } from 'react';
import { X, Trash2, Pencil } from 'lucide-react';
import VoiceTest from './VoiceTest.jsx';
import WakeTraining from './WakeTraining.jsx';
import VoiceWords from './VoiceWords.jsx';
import SystemPanel from './SystemPanel.jsx';
import PermissionsPanel from './PermissionsPanel.jsx';
import PasskeySetup from './PasskeySetup.jsx';
import NotificationsSetup from './NotificationsSetup.jsx';
import PairQr from './PairQr.jsx';

export default function SettingsDrawer({ open, onClose, projects, devices, accounts = [], googleConfigured, api, isLocal }) {
  const [pairing, setPairing] = useState(null);
  const [accountMsg, setAccountMsg] = useState(null);
  const patchAccount = async (id, body) => {
    const res = await api(`/api/accounts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) setAccountMsg((await res.json().catch(() => ({}))).error || 'That did not work.');
  };
  const connectGithub = async () => {
    const res = await api('/api/accounts/github/connect', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    setAccountMsg(body.user_code ? `On github.com/login/device (opened on the laptop) enter: ${body.user_code}` : body.error || 'Could not start the GitHub connection.');
  };
  const connectGmail = async () => {
    const res = await api('/api/accounts/google/connect', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    setAccountMsg(res.ok ? 'Finish signing in in the browser window that opened on the laptop.' : body.error || 'Could not start the Gmail connection.');
  };

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
            <PairQr pairing={pairing} />
            <p className="muted">Phones signed in to your own Tailscale account connect by themselves. Others can tap “Ask the laptop” and you allow them here.</p>
          </section>
        )}

        <section>
          <h3>Accounts</h3>
          {!googleConfigured && <p className="muted">Gmail isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart Novi.</p>}
          {googleConfigured && accounts.length === 0 && <p className="muted">No accounts connected yet.</p>}
          <ul className="list">
            {accounts.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>
                    {a.label}
                    {a.isDefault && <span className="badge done">default</span>}
                    {a.status === 'expired' && <span className="badge failed">expired</span>}
                  </strong>
                  <span className="muted">{a.provider === 'github' ? 'GitHub' : 'Gmail'} · {a.email}</span>
                </div>
                <div className="row-actions">
                  {!a.isDefault && <button className="btn" onClick={() => patchAccount(a.id, { default: true })}>Make default</button>}
                  <button className="icon" aria-label={`Rename ${a.label}`} onClick={() => { const label = window.prompt('New name for this account', a.label); if (label) patchAccount(a.id, { label }); }}><Pencil size={16} /></button>
                  <button className="icon" aria-label={`Disconnect ${a.label}`} onClick={() => { if (window.confirm(`Disconnect ${a.email}? Novi will lose access to this Gmail.`)) api(`/api/accounts/${a.id}`, { method: 'DELETE' }); }}><Trash2 size={16} /></button>
                </div>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button className="btn primary" disabled={!googleConfigured} onClick={connectGmail}>Connect Gmail</button>
            <button className="btn" onClick={connectGithub}>Connect GitHub</button>
          </div>
          {accountMsg && <p className="muted">{accountMsg}</p>}
        </section>

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
          {!isLocal && <PasskeySetup api={api} />}
          {!isLocal && <NotificationsSetup api={api} />}
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

        <section>
          <h3>Permissions</h3>
          <PermissionsPanel api={api} isLocal={isLocal} />
        </section>

        <section>
          <h3>System</h3>
          <SystemPanel api={api} />
        </section>

        <section>
          <h3>Words</h3>
          {isLocal ? <VoiceWords api={api} /> : <p className="muted">Edit your word list on the laptop.</p>}
        </section>
        <section>
          <h3>“Hey Novi”</h3>
          {isLocal ? <WakeTraining api={api} /> : <p className="muted">Train the wake word on the laptop.</p>}
        </section>

        <section>
          <h3>Voice test</h3>
          <p className="muted">Read each sentence once so Novi can learn which speech engine understands you best. Recordings stay on this laptop.</p>
          <VoiceTest api={api} />
        </section>
      </aside>
    </div>
  );
}
