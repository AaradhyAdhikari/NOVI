import { CheckCircle2 } from 'lucide-react';

// Small cards that only say something happened ("Claude finished in NOVI"). One OK clears it everywhere.
export default function NoticeCards({ notices = [], onOk }) {
  if (!notices.length) return null;
  return (
    <div className="notices" role="status" aria-label="Finished tasks">
      {notices.slice(-3).map((n) => (
        <div key={n.id} className="notice">
          <CheckCircle2 size={18} className="notice-icon" />
          <div className="notice-text">
            <strong>{n.title}</strong>
            {n.body && <p>{n.body}</p>}
          </div>
          <button className="btn" onClick={() => onOk(n.id)}>OK</button>
        </div>
      ))}
    </div>
  );
}
