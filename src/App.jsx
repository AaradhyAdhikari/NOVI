// src/App.jsx
import { useRef, useState } from 'react';
import { useNovi } from './lib/useNovi.js';
import { speak, stopSpeaking } from './lib/voice.js';
import { getItem, setItem } from './lib/storage.js';
import StatusBar from './components/StatusBar.jsx';
import Transcript from './components/Transcript.jsx';
import Composer from './components/Composer.jsx';
import TaskPanel from './components/TaskPanel.jsx';
import ApprovalCards from './components/ApprovalCards.jsx';
import TalkButton from './components/TalkButton.jsx';
import PairScreen from './components/PairScreen.jsx';
import SettingsDrawer from './components/SettingsDrawer.jsx';

export default function App() {
  const [muted, setMuted] = useState(() => getItem('novi.muted') === '1');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const novi = useNovi({ onSpeak: (text) => speak(text, { muted: mutedRef.current }) });
  const { state, send } = novi;

  if (novi.needsPairing) return <PairScreen onPair={novi.pair} />;

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setItem('novi.muted', next ? '1' : '0');
    if (next) stopSpeaking();
  };
  const sendText = (text) => send({ type: 'user_message', text });

  return (
    <div className="app">
      <StatusBar connected={novi.connected} providers={state.providers} muted={muted} onToggleMute={toggleMute} onOpenSettings={() => setSettingsOpen(true)} />
      <main className="layout">
        <section className="panel conversation">
          <Transcript entries={state.transcript} thinking={state.thinking} />
          <Composer onSend={sendText} disabled={!novi.connected} />
        </section>
        <section className="panel">
          <TaskPanel task={state.task} feed={state.feed} onStop={() => send({ type: 'stop' })} onAllowEdits={(allow) => send({ type: 'allow_edits', allow })} />
        </section>
      </main>
      <ApprovalCards approvals={state.approvals} onAnswer={(id, allow) => send({ type: 'approval', id, allow })} />
      <TalkButton onText={sendText} api={novi.api} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} projects={state.projects} devices={state.devices} api={novi.api} isLocal={novi.isLocal} />
    </div>
  );
}
