import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';

// Settings → Permissions: kinds of action Novi may do without asking ("Always allow"), with undo,
// and the last things it allowed that way. Sending, deleting and high-risk actions always ask.
export default function PermissionsPanel({ api }) {
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
    </div>
  );
}
