// 'start' / 'end' while Novi talks (hands-free pauses listening), 'spoken' once a message has been delivered.
export const speechEvents = new EventTarget();
const emit = (type, text) => speechEvents.dispatchEvent(new CustomEvent(type, { detail: { text } }));

export function speak(text, { muted } = {}) {
  if (!text) return;
  if (muted || !('speechSynthesis' in window)) {
    emit('spoken', text);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.onstart = () => emit('start', text);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    emit('end', text);
    emit('spoken', text);
  };
  utterance.onend = done;
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
}

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  return () => new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
    };
    recorder.stop();
  });
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const hasBrowserRecognition = Boolean(Recognition);

// Fallback when server speech-to-text is unavailable: one utterance via the browser.
export function listenOnce() {
  return new Promise((resolve, reject) => {
    if (!Recognition) return reject(new Error('Speech recognition is not supported in this browser.'));
    const rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => resolve(e.results[0][0].transcript);
    rec.onerror = (e) => reject(new Error(e.error));
    rec.onend = () => resolve('');
    rec.start();
  });
}
