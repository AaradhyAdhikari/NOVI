import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';

// Settings → Permissions: kinds of action Novi may do without asking ("Always allow"), with undo,
// and the last things it allowed that way. Sending, deleting and high-risk actions always ask.
// Voice PIN for high-risk approvals from a phone. Set and changed only at the laptop.
function RemotePinSettings({ api, isLocal }) {
  const [state, setState] = useState(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState(null);
  const load = () => api('/api/remote-pin').then((r) => r.json()).then(setState).catch(() => {});
  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    const res = await api('/api/remote-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    const body = await res.json().catch(() => ({}));
    setMessage(res.ok ? 'PIN saved.' : body.error || 'Could not save the PIN.');
    setPin('');
    load();
  }

  async function setInput(pinInput) {
    await api('/api/remote-pin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinInput }) });
    load();
  }

  if (!state) return null;
  return (
    <div>
      <h4>Phone PIN</h4>
      <p className="muted">High-risk approvals from your phone need this PIN. Deletes and payments need your fingerprint or face instead. {state.set ? 'A PIN is set.' : 'No PIN yet, so high-risk approvals only work at the laptop.'}</p>
      {isLocal ? (
        <>
          <form onSubmit={save} className="row">
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="4–8 digits" aria-label="New PIN" />
            <button className="btn" type="submit" disabled={!pin}>{state.set ? 'Change PIN' : 'Set PIN'}</button>
          </form>
          <label className="row">
            PIN input
            <select value={state.pinInput} onChange={(e) => setInput(e.target.value)}>
              <option value="voice">Voice only</option>
              <option value="voice-or-typed">Voice or typed</option>
            </select>
          </label>
        </>
      ) : <p className="muted">Set or change the PIN on the laptop.</p>}
      {message && <p className="muted">{message}</p>}
    </div>
  );
}

export default function PermissionsPanel({ api, isLocal }) {
  const [data, setData] = useState({ grants: [], audit: [] });
  const load = () => api('/api/permissions').then((r) => r.json()).then(setData).catch(() => {});

  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function revoke(category) {
    await api(`/api/permissions/${encodeURIComponent(category)}`, { method: 'DELETE' });
    load();
  }

  return (
    <div>
      {data.grants.length === 0
        ? <p className="muted">Novi asks before every action that needs approval. Tap “Always allow …” on a card (or say “yes, always”) to stop being asked about that kind of action.</p>
        : (
          <ul className="list">
            {data.grants.map((g) => (
              <li key={g.category}>
                <div><strong>Always allowed: {g.label}</strong><span className="muted">since {new Date(g.grantedAt).toLocaleString()}</span></div>
                <button className="icon" aria-label={`Stop always allowing ${g.label}`} onClick={() => revoke(g.category)}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        )}
      <p className="muted">Sending, posting, deleting, payments and high-risk actions always ask, whatever is allowed here.</p>
      {data.audit.length > 0 && (
        <details>
          <summary className="muted">Recently allowed without asking ({data.audit.length})</summary>
          <ul className="list">
            {data.audit.map((e) => (
              <li key={`${e.at}${e.title}`}><div><strong>{e.title}</strong><span className="muted">{new Date(e.at).toLocaleString()}</span></div></li>
            ))}
          </ul>
        </details>
      )}
      <RemotePinSettings api={api} isLocal={isLocal} />
    </div>
  );
}
