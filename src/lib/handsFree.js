// Hands-free listening: continuous browser speech recognition that only reacts to
// "Hey Novi …" or to an answer right after Novi asked something. No Groq quota is used.
import { WakeListener, expectsAnswer } from './wake.js';
import { speechEvents } from './voice.js';

const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const handsFreeSupported = Boolean(Recognition);

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch { /* sound is optional */ }
}

export class HandsFree {
  constructor({ onCommand, onState, followUpMs = 8000 }) {
    this.onCommand = onCommand;
    this.onState = onState;
    this.listener = new WakeListener({ followUpMs });
    this.enabled = false;
    this.paused = false;
    this.rec = null;
    this.refreshTimer = null;
    // Diagnostics shown in the status bar: is the mic live, what was last heard, last speech error.
    this.running = false;
    this.lastHeard = '';
    this.lastError = '';
    // Never listen to Novi's own voice: pause while it speaks, then listen for an answer if it asked something.
    this.onSpeechStart = () => this.pause(true);
    this.onSpeechEnd = () => this.pause(false);
    this.onSpoken = (e) => {
      if (!this.enabled || !expectsAnswer(e.detail?.text)) return;
      this.listener.openFollowUp();
      chime();
      this.emitState();
    };
  }

  start() {
    if (!Recognition || this.enabled) return;
    this.enabled = true;
    speechEvents.addEventListener('start', this.onSpeechStart);
    speechEvents.addEventListener('end', this.onSpeechEnd);
    speechEvents.addEventListener('spoken', this.onSpoken);
    this.listen();
  }

  stop() {
    this.enabled = false;
    speechEvents.removeEventListener('start', this.onSpeechStart);
    speechEvents.removeEventListener('end', this.onSpeechEnd);
    speechEvents.removeEventListener('spoken', this.onSpoken);
    this.abort();
    this.emitState();
  }

  // Also used while push-to-talk records, so the two don't fight over the microphone.
  pause(on) {
    this.paused = on;
    if (on) this.abort();
    else this.listen();
    this.emitState();
  }

  abort() {
    try { this.rec?.abort(); } catch { /* already stopped */ }
    this.rec = null;
  }

  listen() {
    if (!this.enabled || this.paused || this.rec) return;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = false;
    // English recognition (Indian English by default when the browser isn't set to English);
    // override with localStorage 'novi.voiceLang', e.g. 'en-US' or 'hi-IN'.
    let lang = null;
    try { lang = window.localStorage.getItem('novi.voiceLang'); } catch { /* storage unavailable */ }
    rec.lang = lang || (String(navigator.language || '').startsWith('en') ? navigator.language : 'en-IN');
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const transcript = e.results[i][0].transcript;
        this.lastHeard = transcript.trim();
        this.lastError = '';
        console.debug('[hands-free] heard:', transcript);
        const heard = this.listener.handle(transcript);
        if (!heard) {
          this.emitState();
          continue;
        }
        chime();
        if (heard.command) this.onCommand(heard.command);
        this.emitState();
      }
    };
    rec.onstart = () => {
      this.running = true;
      this.emitState();
    };
    rec.onerror = (e) => {
      console.debug('[hands-free] error:', e.error);
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.lastError = e.error;
        this.emitState();
      }
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop();
        this.onState?.({ enabled: false, error: 'Microphone blocked: allow it for this page to use "Hey Novi".' });
      }
    };
    // Chrome ends continuous recognition every so often; keep it going while enabled.
    rec.onend = () => {
      this.running = false;
      if (this.rec === rec) this.rec = null;
      if (this.enabled && !this.paused) setTimeout(() => this.listen(), 300);
    };
    this.rec = rec;
    try { rec.start(); } catch { this.rec = null; }
    this.emitState();
  }

  emitState() {
    const awaiting = this.listener.listening;
    clearTimeout(this.refreshTimer);
    if (awaiting) this.refreshTimer = setTimeout(() => this.emitState(), Math.max(0, this.listener.until - Date.now()) + 50);
    this.onState?.({ enabled: this.enabled, paused: this.paused, awaiting, running: this.running, lastHeard: this.lastHeard, lastError: this.lastError });
  }
}
