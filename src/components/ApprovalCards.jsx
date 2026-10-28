import { useState } from 'react';
import { foldDetail } from '../lib/approvalText.js';
import { MessageCircleQuestion, ShieldAlert, ShieldQuestion } from 'lucide-react';
import PinCapture from './PinCapture.jsx';
import { confirmWithPasskey } from '../lib/passkey.js';

// Shown on a phone when an allow needs more proof (server/remoteTrust.js).
const NEED_TEXT = {
  pin: 'This one needs your voice PIN. Say it, or type it below.',
  'no-pin': 'This one needs a voice PIN. Set one in Settings first.',
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

export default function ApprovalCards({ approvals, onAnswer, api, resolved = null }) {
  if (!approvals.length && !resolved) return null;
  return (
    <div className="approvals" role="region" aria-label="Approvals needed">
      {resolved && <div className="approval-status" role="status">{resolved.text}</div>}
      {approvals.map((a) => a.question ? <QuestionCard key={a.id} a={a} onAnswer={onAnswer} /> : (
        <ApprovalCard key={a.id} a={a} onAnswer={onAnswer} api={api} />
      ))}
    </div>
  );
}

// A dangerous laptop command (a.pin) asks for the PIN from the start: no plain Allow that would only be refused.
function ApprovalCard({ a, onAnswer, api }) {
  const need = a.need || (a.pin ? 'pin' : null);
  const pinOnly = need === 'pin' || need === 'no-pin';
  return (
        <div className={`approval ${a.tier}`}>
          <div className="approval-title">
            {a.tier === 'high' ? <ShieldAlert size={18} /> : <ShieldQuestion size={18} />}
            <span>{a.title}</span>
          </div>
          {a.detail && (foldDetail(a.detail)
            ? <details className="detail"><summary>{/'s plan for /.test(a.title || '') ? 'Show the full plan' : a.source === 'claude' ? 'Show the command' : a.source === 'orchestrator' ? 'Show the full brief' : 'Show details'}</summary><pre>{a.detail}</pre></details>
            : <p className="detail">{a.detail}</p>)}
          {a.tier === 'high' && <p className="warn">High risk — this needs your explicit confirmation.</p>}
          {need && <p className="warn">{NEED_TEXT[need]}</p>}
          {need === 'pin' && <PinCapture api={api} onPin={(pin) => onAnswer(a.id, true, null, { proof: pin })} />}
          {need === 'passkey' && (
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
            {!pinOnly && <button className={`btn ${a.tier === 'high' ? 'danger' : 'primary'}`} onClick={() => onAnswer(a.id, true)}>{a.tier === 'high' ? 'Yes, do it' : 'Allow'}</button>}
          </div>
          {a.grant && <p className="muted">Or say “yes, always”.</p>}
        </div>
  );
}
