// The Novi app's own speech recognition (app 2.5.0, PhoneSpeech.kt): words without uploading audio, used by
// the remote view (src/components/LiveScreen.jsx). The app calls window.__noviHeard(id, text, final, error).
export function phoneSpeech(w = globalThis.window) {
  const app = w?.NoviApp;
  try {
    return app && typeof app.recognize === 'function' && app.canRecognize?.() ? app : null;
  } catch {
    return null;
  }
}

let listener = null;
export const onHeard = (fn) => { listener = fn; return () => { if (listener === fn) listener = null; }; };
export const heard = (id, text, final, error) => listener?.({ id, text: String(text || ''), final: Boolean(final), error: String(error || '') });
if (typeof window !== 'undefined') window.__noviHeard = heard;
