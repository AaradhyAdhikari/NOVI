import { Smartphone } from 'lucide-react';

// Laptop: a phone tapped "Ask the laptop to let me in".
export default function PairRequests({ requests = [], api }) {
  if (!requests.length) return null;
  const answer = (id, allow) => api(`/api/pair/requests/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow }) });
  return (
    <div className="approvals" role="region" aria-label="Phones asking to connect">
      {requests.map((r) => (
        <div key={r.id} className="approval medium">
          <div className="approval-title"><Smartphone size={18} /><span>{r.name} wants to connect to Novi</span></div>
          <p className="detail">Only allow it if this is your phone, right now.</p>
          <div className="approval-actions">
            <button className="btn" onClick={() => answer(r.id, false)}>Deny</button>
            <button className="btn primary" onClick={() => answer(r.id, true)}>Allow</button>
          </div>
        </div>
      ))}
    </div>
  );
}
