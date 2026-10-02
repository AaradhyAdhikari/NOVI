import { useState } from 'react';
import { Square, ChevronDown, ChevronUp } from 'lucide-react';

const LABEL = { running: 'Working', done: 'Finished', failed: 'Failed', stopped: 'Stopped' };

export default function TaskPanel({ task, feed, onStop, onAllowEdits }) {
  const [open, setOpen] = useState(true);
  if (!task.active) return <div className="task empty"><p>No coding task yet.</p></div>;
  // Only this task's lines; after a reconnect the live feed is empty, so fall back to the server's recent updates.
  const own = feed.filter((l) => l.taskId === task.id);
  const lines = own.length ? own.slice(-30) : (task.recent || []).map((text, i) => ({ text, at: i }));
  return (
    <div className="task">
      <div className="task-head">
        <div>
          <span className={`badge ${task.status}`}>{LABEL[task.status] || task.status}</span>
          <h2>{task.project} <span className="muted agent">· {task.agent}</span></h2>
          <p className="instruction">{task.instruction}</p>
        </div>
        {task.status === 'running' && <button className="btn danger" onClick={onStop}><Square size={14} /> Stop</button>}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={Boolean(task.allowEdits)} onChange={(e) => onAllowEdits(e.target.checked)} />
        Let the coder edit files without asking (this task only)
      </label>
      <button className="feed-toggle" onClick={() => setOpen(!open)}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Live progress</button>
      {open && (
        <ol className="feed">
          {lines.length === 0 && <li className="muted">Waiting for the coder…</li>}
          {lines.map((l, i) => <li key={`${l.at}-${i}`}>{l.text}</li>)}
        </ol>
      )}
      {task.summary && task.status !== 'running' && <p className="summary">{task.summary}</p>}
    </div>
  );
}
