import { useState } from 'react';
import { MessageCircleQuestion, ShieldAlert, ShieldQuestion } from 'lucide-react';
import PinCapture from './PinCapture.jsx';
import { confirmWithPasskey } from '../lib/passkey.js';

// Shown on a phone when an allow needs more proof (server/remoteTrust.js).
const NEED_TEXT = {
  pin: 'Say your PIN to confirm.',
  passkey: 'Confirm with your fingerprint or face.',
  laptop: 'This one needs you at the laptop.',
};

// One of Claude's own questions: tap an option, type an own answer, or skip (voice works too).
function QuestionCard({ a, onAnswer }) {
  const [own, setOwn] = useState('');
  return (
    <div className="approval question">
      <div className="approval-title">
        <MessageCircleQuestion size={18} />
        <span>{a.title}</span>
      </div>
      <div className="question-options">
        {(a.question.options || []).map((o, i) => (
          <button key={o.label} className="btn" onClick={() => onAnswer(a.id, true, null, { answer: o.label })}>
            <strong>{i + 1}. {o.label}</strong>
            {o.description && <small className="muted"> {o.description}</small>}
          </button>
        ))}
      </div>
      <form className="question-own" onSubmit={(e) => { e.preventDefault(); if (own.trim()) onAnswer(a.id, true, null, { answer: own.trim() }); }}>
        <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="Or type your own answer" aria-label="Your own answer" />
        <button className="btn primary" type="submit" disabled={!own.trim()}>Send</button>
        <button className="btn" type="button" onClick={() => onAnswer(a.id, false)}>Skip</button>
      </form>
      <p className="muted">Or just say the number.</p>
    </div>
  );
}

export default function ApprovalCards({ approvals, onAnswer, api }) {
  if (!approvals.length) return null;
  return (
    <div className="approvals" role="region" aria-label="Approvals needed">
      {approvals.map((a) => a.question ? <QuestionCard key={a.id} a={a} onAnswer={onAnswer} /> : (
        <div key={a.id} className={`approval ${a.tier}`}>
          <div className="approval-title">
            {a.tier === 'high' ? <ShieldAlert size={18} /> : <ShieldQuestion size={18} />}
            <span>{a.title}</span>
          </div>
          {a.detail && <p className="detail">{a.detail}</p>}
          {a.tier === 'high' && <p className="warn">High risk — this needs your explicit confirmation.</p>}
          {a.need && <p className="warn">{NEED_TEXT[a.need]}</p>}
          {a.need === 'pin' && <PinCapture api={api} onPin={(pin) => onAnswer(a.id, true, null, { proof: pin })} />}
          {a.need === 'passkey' && (
            <button className="btn danger" onClick={async () => {
              try { onAnswer(a.id, true, null, { proof: { passkey: await confirmWithPasskey(api, a.id) } }); } catch { /* cancelled: stays pending */ }
            }}>Confirm with fingerprint / face</button>
          )}
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
