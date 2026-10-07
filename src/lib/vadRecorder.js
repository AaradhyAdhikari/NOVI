// Records with Silero VAD (voice-activity detection) in the browser: only real speech is
// kept, at 16 kHz, so silence never costs speech-to-text quota.
// Model and runtime files are served by Novi's server at /vad/ (works offline).
import { MicVAD } from '@ricky0123/vad-web';
import { encodeWav, Utterance } from './utterance.js';

const NO_SPEECH_MS = 8000; // tap mode: give up if nobody starts talking

// mode: 'hold' (until finish()) or 'tap' (ends by itself after the first sentence).
// onAutoDone(blob|null) runs when tap mode ends on its own.
export async function startVadRecording({ mode = 'hold', onAutoDone = () => {} } = {}) {
  const utterance = new Utterance(mode);
  let finished = null;
  let heardSpeech = false;
  let timer = null;

  const vad = await MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/vad/',
    submitUserSpeechOnPause: true,
    redemptionMs: 1000, // this much quiet = end of sentence
    preSpeechPadMs: 300,
    minSpeechMs: 250,
    onSpeechStart: () => { heardSpeech = true; },
    onSpeechEnd: (audio) => {
      if (utterance.addSegment(audio)) finish().then(onAutoDone);
    },
  });

  function finish() {
    if (!finished) {
      clearTimeout(timer);
      finished = (async () => {
        await vad.pause(); // flushes a sentence still in progress
        await vad.destroy();
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

  await vad.start();
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
