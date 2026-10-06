import { Volume2, VolumeX, Settings, Wifi, WifiOff, Ear, EarOff } from 'lucide-react';

export default function StatusBar({ connected, providers, muted, onToggleMute, onOpenSettings, handsFree = {}, onToggleHandsFree }) {
  const hf = !handsFree.on ? null : handsFree.error ? 'Mic blocked' : handsFree.paused ? 'Paused while talking' : handsFree.awaiting ? 'Listening…' : 'Say “Hey Novi”';
  const active = providers.find((p) => p.healthy && p.lastModel) || providers.find((p) => p.healthy);
  return (
    <header className="statusbar">
      <div className="brand"><span className="dot" />NOVI</div>
      <div className="chips">
        <span className={`chip ${connected ? 'ok' : 'bad'}`}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? 'Connected' : 'Reconnecting…'}</span>
        <span className={`chip ${active ? 'ok' : 'bad'}`} title={providers.map((p) => `${p.name}: ${p.healthy ? 'ok' : 'cooling down'}${p.coolingKeys ? ` (${p.coolingKeys} key(s) rate-limited)` : ''}`).join('\n')}>
          {active ? `Brain: ${active.name}` : 'No AI provider'}
        </span>
        {hf && <span className={`chip ${handsFree.awaiting ? 'ok listening' : ''}`}>{hf}{handsFree.on && !handsFree.paused && !handsFree.running ? ' (mic starting…)' : ''}</span>}
        {handsFree.on && handsFree.lastError && <span className="chip bad" title="Chrome speech recognition error">Speech error: {handsFree.lastError}</span>}
        {handsFree.on && handsFree.lastHeard && <span className="chip heard" title="What Chrome heard last">Heard: “{handsFree.lastHeard.slice(0, 40)}”</span>}
      </div>
      <div className="actions">
        {handsFree.supported && (
          <button className={`icon ${handsFree.on ? 'active' : ''}`} onClick={onToggleHandsFree} aria-pressed={Boolean(handsFree.on)} aria-label={handsFree.on ? 'Turn off hands-free (Hey Novi)' : 'Turn on hands-free (Hey Novi)'} title="Hands-free: say “Hey Novi”">
            {handsFree.on ? <Ear size={18} /> : <EarOff size={18} />}
          </button>
        )}
        <button className="icon" onClick={onToggleMute} aria-label={muted ? 'Unmute voice' : 'Mute voice'}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
        <button className="icon" onClick={onOpenSettings} aria-label="Settings"><Settings size={18} /></button>
      </div>
    </header>
  );
}
