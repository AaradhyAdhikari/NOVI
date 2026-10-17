import { useEffect, useState } from 'react';

// "Show me the code for the contact page": the actual code in the chat. Edit opens it for changes;
// Approve saves the new version into the project (and a running Claude is told). Nothing changes
// until Approve.
export default function CodeCard({ code, caption, saved, onSave }) {
  const [text, setText] = useState(code.text);
  const [draft, setDraft] = useState(code.text);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!saving || !saved) return;
    setSaving(false);
    if (saved.ok) { setText(draft); setEditing(false); }
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = () => { setSaving(true); onSave(code.id, draft); };
  const rows = Math.min(24, Math.max(6, draft.split('\n').length + 1));
  return (
    <div className="code-card">
      <div className="code-head">{caption || `${code.file} · from line ${code.start}`}</div>
      {editing ? (
        <textarea id={`code-${code.id}`} className="code-edit" value={draft} rows={rows} spellCheck={false}
          autoCapitalize="off" autoCorrect="off" aria-label={`Edit ${code.file}`} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <pre className="code-view"><code>{text}</code></pre>
      )}
      <div className="code-actions">
        {editing ? (
          <>
            <button className="btn" disabled={saving} onClick={() => { setDraft(text); setEditing(false); }}>Cancel</button>
            <button className="btn primary" disabled={saving || draft === text} onClick={approve}>{saving ? 'Saving…' : 'Approve'}</button>
          </>
        ) : (
          <button className="btn" onClick={() => { setDraft(text); setEditing(true); }}>Edit</button>
        )}
      </div>
      {saved && !saving && <p className={saved.ok ? 'code-status' : 'code-status bad'}>{saved.ok ? (saved.changed ? 'Saved to the project.' : 'No changes.') : saved.error}</p>}
    </div>
  );
}
