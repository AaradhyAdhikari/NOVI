import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';

// Settings → Shortcuts (laptop only): words Novi learned to do at once, without the AI
// (server/brain/shortcuts.js). Remove one if Novi learned it wrong.
export default function ShortcutsPanel({ api }) {
  const [items, setItems] = useState(null);
  const load = () => api('/api/shortcuts').then((r) => r.json()).then((b) => setItems(b.shortcuts || [])).catch(() => setItems([]));
  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (key) => {
    await api(`/api/shortcuts?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    load();
  };

  if (!items) return <p className="muted">Loading…</p>;
  if (!items.length) return <p className="muted">Nothing yet. When the AI works out a simple request, Novi remembers it and does it at once next time.</p>;
  return (
    <ul className="cmd-history">
      {items.map((s) => (
        <li key={s.key}>
          <div className="cmd-head">
            <strong>“{s.said}”</strong>
            <button className="icon" aria-label={`Forget “${s.said}”`} title="Forget this shortcut" onClick={() => remove(s.key)}><Trash2 size={16} /></button>
          </div>
          <span className="muted">→ {s.tool} · used {s.uses} time{s.uses === 1 ? '' : 's'}</span>
        </li>
      ))}
    </ul>
  );
}
