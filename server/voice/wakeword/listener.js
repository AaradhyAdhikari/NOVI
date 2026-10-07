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
}) {
  let running = false;
  let clock = 0;
  let cooldownUntil = 0;
  let noise = 0; // background loudness, learned while waiting for the wake word
  let command = null; // { frames, heard, quietMs, elapsedMs } while recording a command

  function finish() {
    const { frames, heard } = command;
    command = null;
    cooldownUntil = clock + cooldownMs;
    if (!heard) return onNoCommand();
    const audio = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) { audio.set(f, at); at += f.length; }
    onCommand(audio);
  }

  async function step(frame) {
    clock += FRAME_MS;
    const scores = await detector.process(frame); // keep the detector's history continuous
    if (!command) {
      const level = rms(frame);
      // Slow average (starting from silence) that a short loud sound can't drag up much.
      noise = noise * 0.9 + Math.min(level, noise * 2 + 50) * 0.1;
      const best = Math.max(0, ...scores);
      if (best >= threshold && clock >= cooldownUntil) {
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
    if ((command.heard && command.quietMs >= endSilenceMs) || (!command.heard && command.elapsedMs >= noSpeechMs) || command.elapsedMs >= maxCommandMs) finish();
  }

  return {
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
