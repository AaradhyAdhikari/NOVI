// src/App.jsx
import { useEffect, useRef, useState } from 'react';
import { useNovi } from './lib/useNovi.js';
import { speak, stopSpeaking } from './lib/voice.js';
import { HandsFree, handsFreeSupported, chime } from './lib/handsFree.js';
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
  const [handsFreeState, setHandsFreeState] = useState({ enabled: false });
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const novi = useNovi({ onSpeak: (text) => speak(text, { muted: mutedRef.current }) });
  const { state, send } = novi;
  // Voice-first: "Hey Novi" is always listening (no on/off switch). When the server has a
  // wake-word model it listens on the laptop mic (even with this page closed) and the browser stays quiet.
  const serverWake = state.wakeWord === 'server';
  const handsFreeOn = handsFreeSupported && !serverWake;
  const sendText = (text) => send({ type: 'user_message', text });
  const sendRef = useRef(sendText);
  sendRef.current = sendText;
  const handsFree = useRef(null);

  useEffect(() => {
    if (!handsFreeSupported) return undefined;
    handsFree.current = new HandsFree({ onCommand: (text) => sendRef.current(text), onState: setHandsFreeState });
    return () => handsFree.current?.stop();
  }, []);

  useEffect(() => {
    if (!handsFree.current || novi.needsPairing) return;
    if (handsFreeOn) handsFree.current.start();
    else handsFree.current.stop();
  }, [handsFreeOn, novi.needsPairing]);

  useEffect(() => { if (state.wakeHeardAt) chime(); }, [state.wakeHeardAt]);

  if (novi.needsPairing) return <PairScreen onPair={novi.pair} />;

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setItem('novi.muted', next ? '1' : '0');
    if (next) stopSpeaking();
  };

  return (
    <div className="app">
      <StatusBar
        connected={novi.connected}
        providers={state.providers}
        muted={muted}
        onToggleMute={toggleMute}
        onOpenSettings={() => setSettingsOpen(true)}
        handsFree={serverWake ? { supported: true, on: true, server: true, running: true, awaiting: Boolean(state.wakeHeardAt) && !state.thinking } : { supported: handsFreeSupported, on: handsFreeOn, ...handsFreeState }}
      />
      <main className="layout">
        <section className="panel conversation">
          <Transcript entries={state.transcript} thinking={state.thinking} />
          <Composer onSend={sendText} disabled={!novi.connected} />
        </section>
        <section className="panel">
          <TaskPanel task={state.task} feed={state.feed} onStop={() => send({ type: 'stop' })} onAllowEdits={(allow) => send({ type: 'allow_edits', allow })} />
        </section>
      </main>
      <ApprovalCards approvals={state.approvals} onAnswer={(id, allow, choice) => send({ type: 'approval', id, allow, ...(choice ? { choice } : {}) })} />
      <TalkButton onText={sendText} api={novi.api} onRecording={(on) => handsFree.current?.enabled && handsFree.current.pause(on)} handsFreeOn={handsFreeOn || serverWake} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} projects={state.projects} devices={state.devices} accounts={state.accounts} googleConfigured={state.googleConfigured} api={novi.api} isLocal={novi.isLocal} />
    </div>
  );
}
