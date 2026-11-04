import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { countParts } from '../lib/changeCounts.js';

const post = (api, url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const MARK = { add: '+', del: '−', ctx: ' ', gap: '' };

// A file's changed lines, or its whole code with the changed lines marked. Edit saves into the project,
// and the card behind refreshes, so the yes covers what is really going out.
function ChangesView({ id, file, api, onClose }) {
  const [tab, setTab] = useState('changes');
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  // Only the newest answer counts, and each one says which tab it is for: a slow reply must never fill
  // the other tab.
  const asked = useRef(0);
  const load = (whole) => {
    const turn = ++asked.current;
    const show = (data) => { if (turn === asked.current) setView({ ...data, whole }); };
    setView(null);
    post(api, '/api/card-changes', { id, file, whole }).then(show).catch(() => show({ error: "Couldn't reach Novi." }));
  };
  useEffect(() => { load(tab === 'code'); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setStatus('');
    const out = await post(api, '/api/card-changes/save', { card: id, file, id: view.editId, text: draft }).catch(() => ({ ok: false, error: "Couldn't reach Novi." }));
    setSaving(false);
    if (!out.ok) { setStatus(out.error || "That didn't save."); return; }
    setDraft(null);
    setStatus(out.changed ? 'Saved. The card now shows this change.' : 'No changes.');
    load(true);
  };

  const shown = view && view.whole === (tab === 'code') ? view : null;
  const changed = new Set(shown?.changed || []);
  const note = !shown ? 'Loading…'
    : shown.error || (shown.binary && 'This file isn\'t text, so there are no lines to show.')
    || (shown.gone && 'This file was deleted.') || (shown.tooBig && 'This file is too big to show here. Open it on the laptop.') || '';
  return createPortal(
    <div className="changes-view" role="dialog" aria-label={`Changes in ${file}`}>
      <div className="changes-head">
        <strong>{file}</strong>
        <button className="btn" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="changes-tabs">
        <button className="btn" aria-pressed={tab === 'changes'} disabled={draft !== null} onClick={() => setTab('changes')}>Changes</button>
        <button className="btn" aria-pressed={tab === 'code'} disabled={draft !== null} onClick={() => setTab('code')}>Full code</button>
      </div>
      {note ? <p className="changes-note">{note}</p> : draft !== null ? (
        <div className="changes-body editing">
          <textarea className="code-edit" value={draft} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={`Edit ${file}`} onChange={(e) => setDraft(e.target.value)} />
        </div>
      ) : (
        <div className="changes-body">
          {tab === 'changes'
            ? (shown.lines || []).map((l, i) => <div key={i} className={`code-row ${l.type}`}><span className="code-row-mark">{MARK[l.type]}</span><span>{l.text || ' '}</span></div>)
            : (shown.text || '').replace(/\n$/, '').split('\n').map((text, i) => <div key={i} className={`code-row ${changed.has(i + 1) ? 'changed' : ''}`}><span className="code-row-mark">{i + 1}</span><span>{text || ' '}</span></div>)}
          {shown.cut && <p className="changes-note">Only the first lines are shown. Open the file on the laptop for the rest.</p>}
        </div>
      )}
      {status && <p className="code-status">{status}</p>}
      {tab === 'code' && shown?.editId && (
        <div className="code-actions">
          {draft === null
            ? <button className="btn" onClick={() => { setStatus(''); setDraft(shown.text); }}>Edit</button>
            : (
              <>
                <button className="btn" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
                <button className="btn primary" disabled={saving || draft === shown.text} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
              </>
            )}
        </div>
      )}
    </div>,
    document.body,
  );
}

// On the commit card: the message, then each file with its counts. Tap a file to look inside.
export default function ChangeList({ changes, api }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="changes">
      {changes.message && <p className="changes-message">{changes.message}</p>}
      {changes.note && <p className="muted">{changes.note}</p>}
      <ul className="changes-files">
        {changes.files.map((f) => (
          <li key={f.file}>
            <button className="change-row" onClick={() => setOpen(f.file)}>
              <span className="change-file">{f.file}</span>
              {countParts(f).map((c) => <span key={c.kind} className={`change-count ${c.kind}`}>{c.text}</span>)}
            </button>
          </li>
        ))}
      </ul>
      {changes.more > 0 && <p className="muted">and {changes.more} more</p>}
      {changes.left?.length > 0 && <p className="muted">Left out: {changes.left.join(', ')}</p>}
      {open && <ChangesView id={changes.id} file={open} api={api} onClose={() => setOpen(null)} />}
    </div>
  );
}
