import { Volume2, VolumeX, Settings, Wifi, WifiOff } from 'lucide-react';

export default function StatusBar({ connected, providers, muted, onToggleMute, onOpenSettings }) {
  const active = providers.find((p) => p.healthy && p.lastModel) || providers.find((p) => p.healthy);
  return (
    <header className="statusbar">
      <div className="brand"><span className="dot" />NOVI</div>
      <div className="chips">
        <span className={`chip ${connected ? 'ok' : 'bad'}`}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}{connected ? 'Connected' : 'Reconnecting…'}</span>
        <span className={`chip ${active ? 'ok' : 'bad'}`} title={providers.map((p) => `${p.name}: ${p.healthy ? 'ok' : 'cooling down'}${p.coolingKeys ? ` (${p.coolingKeys} key(s) rate-limited)` : ''}`).join('\n')}>
          {active ? `Brain: ${active.name}` : 'No AI provider'}
        </span>
      </div>
      <div className="actions">
        <button className="icon" onClick={onToggleMute} aria-label={muted ? 'Unmute voice' : 'Mute voice'}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
        <button className="icon" onClick={onOpenSettings} aria-label="Settings"><Settings size={18} /></button>
      </div>
    </header>
  );
}
