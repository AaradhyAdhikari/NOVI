import { useState } from 'react';
import { Send } from 'lucide-react';

export default function Composer({ onSend, disabled }) {
  const [text, setText] = useState('');
  function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  }
  return (
    <form className="composer" onSubmit={submit}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type to Novi…" aria-label="Message Novi" disabled={disabled} />
      <button className="icon" aria-label="Send" disabled={disabled || !text.trim()}><Send size={18} /></button>
    </form>
  );
}
