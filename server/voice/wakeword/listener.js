// Always-on "Hey Novi": reads the laptop microphone in the server (works with the browser
// closed), waits for the wake word, then records the spoken command until a pause.
const FRAME_MS = 80;

const rms = (frame) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
};

// Laptop mics often record speech very quietly; Whisper guesses better at a normal level.
export function normalizeVolume(samples, maxGain = 50) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gain = peak ? Math.min(maxGain, (0.9 * 32767) / peak) : 1;
  if (gain <= 1) return samples;
  return Int16Array.from(samples, (s) => Math.round(s * gain));
}

export function createWakeListener({
  recorder,
  detector,
  onWake,
  onCommand,
  onNoCommand = () => {},
  onError = () => {},
  threshold = 0.5,
  minSpeechRms = 150, // never treat anything quieter than this as speech
  speechFactor = 3, // speech = this many times louder than the room's background noise
  endSilenceMs = 1000, // this much quiet after speech = command finished
  noSpeechMs = 4000, // nobody spoke after the wake word
  maxCommandMs = 8000,
  cooldownMs = 1500, // ignore the tail of the same wake word
  // Only the owner: (audio) → true (their voice) / false (someone else) / null (check off: anyone
  // wakes Novi, nobody can interrupt it). Errors let the audio through (never deaf).
  checkSpeaker = null,
  interruptThreshold = null, // while Novi talks; null = threshold + 0.15 (its own voice can score)
  onInterrupt = () => {},
  onRejected = () => {},
}) {
  let running = false;
  let clock = 0;
  let cooldownUntil = 0;
  let noise = 0; // background loudness, learned while waiting for the wake word
  let command = null; // { frames, heard, quietMs, elapsedMs } while recording a command
  let capturing = null; // { left, frames, best, resolve } while recording a practice clip
  let deafUntil = 0; // conversation mode: ignore the mic while Novi itself is speaking
  let speaking = false; // Novi is talking on the laptop right now
  const recent = []; // the last 1.5 s of mic audio, for the voice check on "Hey Novi"
  const RECENT_FRAMES = 19;
  const verdict = async (audio) => {
    if (!checkSpeaker) return null;
    try {
      const v = await checkSpeaker(audio);
      return v == null ? null : Boolean(v);
    } catch {
      return null;
    }
  };
  const safeCheck = async (audio) => (await verdict(audio)) !== false;
  const join = (frames) => {
    const audio = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) { audio.set(f, at); at += f.length; }
    return audio;
  };

  async function finish() {
    const { frames, heard, followUp = false } = command;
    command = null;
    cooldownUntil = clock + cooldownMs;
    if (!heard) return onNoCommand({ followUp });
    const audio = join(frames);
    // A follow-up has no "Hey Novi" to check, so check the sentence itself.
    if (followUp && !(await safeCheck(audio))) return onNoCommand({ followUp });
    onCommand(audio, { followUp });
  }

  async function step(frame) {
    clock += FRAME_MS;
    const scores = await detector.process(frame); // keep the detector's history continuous
    // Recording a practice clip ("Hey Novi" for training): never wake while it runs.
    if (capturing) {
      capturing.frames.push(frame);
      capturing.best = Math.max(capturing.best, ...scores);
      if (--capturing.left <= 0) {
        const { frames, best, resolve } = capturing;
        capturing = null;
        cooldownUntil = clock + cooldownMs;
        resolve({ audio: join(frames), best });
      }
      return;
    }
    recent.push(frame);
    if (recent.length > RECENT_FRAMES) recent.shift();
    if (speaking || clock <= deafUntil) {
      // Novi is talking: a strong "Hey Novi" in the owner's voice stops it.
      const best = Math.max(0, ...scores);
      const level = interruptThreshold ?? threshold + 0.15;
      if (best >= level && clock >= cooldownUntil && (await verdict(join(recent))) === true) {
        speaking = false;
        deafUntil = 0;
        cooldownUntil = clock + cooldownMs;
        onInterrupt();
        command = { frames: [], heard: false, quietMs: 0, elapsedMs: 0, waitMs: 8000, followUp: true };
      }
      return;
    }
    if (!command) {
      const level = rms(frame);
      // Slow average (starting from silence) that a short loud sound can't drag up much.
      noise = noise * 0.9 + Math.min(level, noise * 2 + 50) * 0.1;
      const best = Math.max(0, ...scores);
      if (best >= threshold && clock >= cooldownUntil) {
        if (!(await safeCheck(join(recent)))) {
          cooldownUntil = clock + cooldownMs;
          onRejected({ score: best });
          return;
        }
        command = { frames: [], heard: false, quietMs: 0, elapsedMs: 0 };
        onWake(best);
      }
      return;
    }
    command.elapsedMs += FRAME_MS;
    if (rms(frame) >= Math.max(minSpeechRms, noise * speechFactor)) {
      command.heard = true;
      command.quietMs = 0;
    } else {
      command.quietMs += FRAME_MS;
    }
    if (command.heard) command.frames.push(frame);
    if ((command.heard && command.quietMs >= endSilenceMs) || (!command.heard && command.elapsedMs >= (command.waitMs ?? noSpeechMs)) || command.elapsedMs >= maxCommandMs) await finish();
  }

  return {
    // The next `ms` of mic audio and the best wake score in it (for "Hey Novi" practice clips).
    capture(ms) {
      return new Promise((resolve) => {
        capturing = { left: Math.ceil(ms / FRAME_MS), frames: [], best: 0, resolve };
      });
    },
    // Conversation mode: after Novi answers, listen for the next sentence without the wake word.
    // deafMs: how long Novi will be speaking (so it doesn't answer itself); waitMs: how long to wait.
    followUp({ deafMs = 0, waitMs = 8000 } = {}) {
      deafUntil = clock + deafMs;
      command = { frames: [], heard: false, quietMs: 0, elapsedMs: 0, waitMs, followUp: true };
    },
    // Novi started / stopped talking on the laptop. Off leaves a short tail for the room's echo.
    // (After an interrupt Novi already counts as silent: a late "stopped" must not deafen the
    // sentence the owner is already saying.)
    setSpeaking(on) {
      const was = speaking;
      speaking = Boolean(on);
      if (was && !speaking) deafUntil = Math.max(deafUntil, clock + 300);
    },
    setThreshold(value) {
      threshold = value;
    },
    async start() {
      running = true;
      recorder.start();
      try {
        while (running) {
          const frame = await recorder.read();
          if (!running) break;
          await step(Int16Array.from(frame));
        }
      } catch (err) {
        running = false;
        onError(err);
      }
    },
    stop() {
      if (!running) return;
      running = false;
      try { recorder.stop(); } catch { /* already stopped */ }
    },
  };
}
