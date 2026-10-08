# Novi speaker check + "Hey Novi" interrupt — design (2026-10-08)

## Goal
1. **Only the owner's voice wakes Novi** on the laptop wake mic. A TV, a video, a visitor or a family
   member saying "Hey Novi" is ignored silently.
2. **The owner can interrupt Novi while it is talking** (Phase A: by saying "Hey Novi"). Novi stops
   speaking at once, keeps any running task going, and listens for the next sentence.

Success: the TV/YouTube never wakes Novi; the owner is accepted on normal days; "Hey Novi" during a long
reply silences it within ~0.3 s and the next sentence is understood.

## Decisions (agreed with the user)
- Not the owner → **ignore completely** (no reply, no limited mode). Log line only.
- Interrupt → **stop talking, keep listening** (~8 s, like conversation mode). Tasks are not cancelled.
- Trigger → **Phase A now: "Hey Novi" interrupts.** Phase B ("Novi stop" model) is a later, separate spec:
  first try sherpa-onnx open keyword spotting; only if that is poor, record ~50 clips and train
  `novi_stop.onnx` with the existing Colab notebook.
- Engine → **`sherpa-onnx-node`** (npm, Apache-2.0, prebuilt Windows addon) with a free WeSpeaker
  ResNet34 VoxCeleb ONNX speaker-embedding model (~25 MB). No Python.
- Scope: laptop wake mic only. Phone / browser talk button is not checked (paired device, in the hand).
- This is a convenience filter, **not** a security barrier: approvals, voice PIN and passkeys are unchanged.

## Components
### `server/voice/speaker/verifier.js` (new)
Narrow interface so tests use a fake:
```
createSpeakerVerifier({ modelPath, load = <sherpa loader> }) → null | {
  embed(int16Audio16k) → Float32Array   // voiceprint of a clip
  score(embedding, voiceprint) → number // cosine similarity, -1..1
}
```
Returns `null` when the model file is missing or fails to load (feature off, warning recorded).

### `server/voice/speaker/enroll.js` (new)
- `enroll({ verifier, clips })` → `{ voiceprint, clipCount, selfScores: [min, max], suggested }`.
  Voiceprint = normalized mean of clip embeddings. `selfScores` = each clip vs the mean of the others
  (leave-one-out). `suggested` = a little below the lowest self score (min − 0.1, floored at 0.25).
- Clips come from `data/voice-samples/hey-novi` (the existing practice recordings).
- Saved to `data/voiceprint.json`: `{ voiceprint: number[], clipCount, selfScores, strictness, enabled, model, createdAt }`.
  Private, never uploaded (data/ is gitignored and only backed up to the user's own Drive).

### `server/voice/wakeword/listener.js` (changed)
- New options: `checkSpeaker(audio) → boolean | Promise<boolean>` (default: always true),
  `interruptMargin = 0.15`, `onInterrupt()`, `onRejected(info)`.
- Keeps a rolling ~1.5 s buffer of recent frames.
- **On wake score ≥ threshold** (not speaking): run `checkSpeaker(last 1.5 s)`. Owner → wake as today.
  Not owner → `onRejected({ score })`, cooldown, stay idle.
- **Follow-up commands** (conversation mode): when the command finishes, check the command audio;
  not owner → treated as no command (conversation ends quietly).
- **While Novi speaks** (existing `deafUntil` window, now also settable via `setSpeaking(bool)`): the
  detector keeps scoring; if score ≥ threshold + interruptMargin **and** `checkSpeaker` passes →
  end the deaf window, call `onInterrupt()`, start a follow-up capture (`waitMs` 8000).
- Errors inside `checkSpeaker` → let the audio through (log once). Novi must never go deaf.

### `server/voice/wakeword/service.js` (changed)
Builds the verifier + saved voiceprint into `checkSpeaker` (score ≥ strictness), passes
`NOVI_WAKEWORD_INTERRUPT_THRESHOLD` (absolute level, overrides threshold + margin) and wires
`onInterrupt` → `speaker.stop()` + broadcast `{ type: 'stop_speaking' }` to laptop pages.
With `NOVI_WAKEWORD_DEBUG=1`, logs `voice match 0.74 ✓ / 0.31 ✗`.

### `server/voice/localSpeaker.js` (changed)
`say.stop()`: bumps a generation counter so queued lines are dropped, kills the PowerShell voice
process (its pending waits resolve via the existing `died` path), and starts a fresh process in the
background so the next reply is not delayed by the ~2.5 s start-up.

### `server/app.js` (changed)
- `POST /api/voiceprint/learn` → runs enrollment, saves, returns the summary.
- `GET /api/voiceprint` → `{ available, enabled, clipCount, selfScores, strictness }` (no voiceprint numbers).
- `POST /api/voiceprint` `{ enabled?, strictness? }` → saves settings.
- Practice-clip result gains `voiceMatch` when a voiceprint exists.
- `/api/health` reports `speakerCheck: 'on' | 'off' | 'no-model' | 'error'`.

### UI
- `src/lib/voice.js`: `stopAll()` (clears the reply queue, stops current audio / speechSynthesis);
  called on a `stop_speaking` WebSocket message.
- Settings → "Hey Novi": "Learn my voice" button with the summary, "Only my voice" switch,
  strictness slider, and "voice match" next to each practice-clip score.
- Settings → System: speaker-check status from `/api/health`.

## Model setup (user, once)
Download the WeSpeaker ResNet34 ONNX file from the sherpa-onnx speaker-recognition model release
into `models/speaker/` (gitignored, like the wake-word models). Optional `NOVI_SPEAKER_MODEL` = path.
Novi never downloads it by itself. No model → feature off, Novi behaves exactly as today.

## Error handling
| Case | Behaviour |
|---|---|
| No model / no voiceprint / switch off | Check off; wake word as today |
| Model fails to load | Check off; warning in Settings → System and logs |
| `embed` throws on one clip | Let that wake through; log once |
| Voice process killed mid-reply | Pending waits resolve; nothing hangs; next reply restarts it |
| Fewer than 5 clips at enrollment | Refuse with "record at least 5 'Hey Novi' clips first" |

## Testing (Vitest, TDD; real model never used)
- Listener with a fake detector + fake `checkSpeaker`: owner wakes; other ignored + `onRejected`;
  follow-up from other = no command; `checkSpeaker` throwing = wake allowed.
- Interrupt: normal-level score while speaking → no interrupt; threshold + margin + owner → `onInterrupt`
  then a follow-up capture; other voice at high score → no interrupt; explicit interrupt threshold env wins.
- `localSpeaker.stop()`: kills the child, drops queued lines, next `say` spawns again (fake `spawn`).
- Enrollment with a fake verifier: mean voiceprint, leave-one-out self scores, suggested strictness,
  refuses < 5 clips.
- Service: no model → `checkSpeaker` absent and wake behaves as before; strictness from voiceprint.json.
- App routes: learn / get / set voiceprint; health field.
- Full suite stays green.

## Out of scope
Phase B "Novi stop" model; checking the phone/browser talk button; cancelling running tasks by voice;
echo cancellation.
