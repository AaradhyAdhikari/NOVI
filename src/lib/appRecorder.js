// Inside the Novi Android app the page's own mic doesn't start (live 2026-10-28: "Microphone
// unavailable" in the app's WebView), so the talk button asks the app to record with its own mic.
// The app stops by itself when you pause (or on "stop") and hands back the speech as a WAV, which the
// page sends to speech-to-text as usual. Same shape as the VAD recorder: finish(), switchToTap().
const waiting = new Map();
let seq = 0;

// The app's bridge (android/…/MainActivity.kt adds window.NoviApp), else null (a normal browser).
export function appBridge(w = globalThis.window) {
  return w?.NoviApp && typeof w.NoviApp.record === 'function' ? w.NoviApp : null;
}

function wavBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}

// Called by the app when a recording is over: base64 WAV, or null when nobody spoke.
export function deliverAppAudio(id, b64) {
  const done = waiting.get(String(id));
  if (!done) return;
  waiting.delete(String(id));
  done(b64 ? wavBlob(b64) : null);
}

export function startAppRecording({ app, onAutoDone = () => {} }) {
  const id = String((seq += 1));
  let finishing = false;
  const result = new Promise((resolve) => waiting.set(id, resolve));
  result.then((blob) => { if (!finishing) onAutoDone(blob); });
  app.record(id);
  return {
    // The app always ends on a pause, so a tap needs nothing more.
    switchToTap() {},
    finish() {
      finishing = true;
      app.stop(id);
      return result;
    },
  };
}

if (typeof window !== 'undefined') window.__noviAppAudio = deliverAppAudio;
