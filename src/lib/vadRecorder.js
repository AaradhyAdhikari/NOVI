// Records with Silero VAD (voice-activity detection) in the browser: only real speech is
// kept, at 16 kHz, so silence never costs speech-to-text quota.
// Model and runtime files are served by Novi's server at /vad/ (works offline).
// One detector is loaded once (warmVad) and reused: each recording only switches the mic on
// (start) and off (pause), so tapping the button doesn't reload the model every time.
import { MicVAD } from '@ricky0123/vad-web';
import { encodeWav, Utterance } from './utterance.js';

const NO_SPEECH_MS = 8000; // tap mode: give up if nobody starts talking

let shared = null; // Promise<MicVAD>
let current = null; // the recording in progress: { speechStart(), speechEnd(audio) }

// Load the model without touching the mic. Safe to call early (e.g. when the page opens).
export function warmVad() {
  shared ||= MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/vad/',
    startOnLoad: false,
    submitUserSpeechOnPause: true,
    redemptionMs: 700, // this much quiet = end of sentence
    preSpeechPadMs: 300,
    minSpeechMs: 250,
    onSpeechStart: () => current?.speechStart(),
    onSpeechEnd: (audio) => current?.speechEnd(audio),
  }).catch((err) => { shared = null; throw err; });
  return shared;
}

// mode: 'hold' (until finish()) or 'tap' (ends by itself after the first sentence).
// onAutoDone(blob|null) runs when tap mode ends on its own.
export async function startVadRecording({ mode = 'hold', onAutoDone = () => {} } = {}) {
  let vad = await warmVad();
  // A failed first start (e.g. the phone's mic prompt was dismissed) leaves the detector stuck: start over.
  if (vad.initializationState === 'errored') {
    shared = null;
    vad = await warmVad();
  }
  const utterance = new Utterance(mode);
  let finished = null;
  let heardSpeech = false;
  let timer = null;

  const me = {
    speechStart: () => { heardSpeech = true; },
    speechEnd: (audio) => { if (utterance.addSegment(audio)) finish().then(onAutoDone); },
  };

  function finish() {
    if (!finished) {
      clearTimeout(timer);
      finished = (async () => {
        await vad.pause(); // mic off; flushes a sentence still in progress
        if (current === me) current = null;
        const audio = utterance.audio();
        return audio ? new Blob([encodeWav(audio, 16000)], { type: 'audio/wav' }) : null;
      })();
    }
    return finished;
  }

  function armNoSpeechTimer() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!heardSpeech) finish().then(onAutoDone); }, NO_SPEECH_MS);
  }

  current = me;
  await vad.start();
  if (vad.initializationState === 'errored') throw new Error(vad.errored || 'Microphone unavailable');
  // Phones may create the audio engine paused; without this no sound reaches the detector.
  if (vad._audioContext?.state === 'suspended') await vad._audioContext.resume().catch(() => {});
  if (mode === 'tap') armNoSpeechTimer();

  return {
    finish,
    // A quick tap turns a hold into hands-off listening.
    switchToTap() {
      utterance.mode = 'tap';
      if (utterance.segments.length) finish().then(onAutoDone);
      else armNoSpeechTimer();
    },
  };
}
