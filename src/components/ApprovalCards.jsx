import { ShieldAlert, ShieldQuestion } from 'lucide-react';

export default function ApprovalCards({ approvals, onAnswer }) {
  if (!approvals.length) return null;
  return (
    <div className="approvals" role="region" aria-label="Approvals needed">
      {approvals.map((a) => (
        <div key={a.id} className={`approval ${a.tier}`}>
          <div className="approval-title">
            {a.tier === 'high' ? <ShieldAlert size={18} /> : <ShieldQuestion size={18} />}
            <span>{a.title}</span>
          </div>
          {a.detail && <p className="detail">{a.detail}</p>}
          {a.tier === 'high' && <p className="warn">High risk — this needs your explicit confirmation.</p>}
          <div className="approval-actions">
            <button className="btn" onClick={() => onAnswer(a.id, false)}>Deny</button>
            {(a.choices || []).map((c) => (
              <button key={c.id} className="btn" onClick={() => onAnswer(a.id, true, c.id)}>{c.label}</button>
            ))}
            {a.grant && (
              <button className="btn" title="Novi won't ask again for this kind of action. Undo in Settings → Permissions." onClick={() => onAnswer(a.id, true, null, { always: true })}>
                Always allow {a.grant.label}
              </button>
            )}
            <button className={`btn ${a.tier === 'high' ? 'danger' : 'primary'}`} onClick={() => onAnswer(a.id, true)}>{a.tier === 'high' ? 'Yes, do it' : 'Allow'}</button>
          </div>
          {a.grant && <p className="muted">Or say “yes, always”.</p>}
        </div>
      ))}
    </div>
  );
}
