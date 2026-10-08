# Speaker check + "Hey Novi" interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the owner's voice wakes Novi on the laptop wake mic, and saying "Hey Novi" while Novi talks stops it and listens for the next sentence.

**Architecture:** A small verifier (`server/voice/speaker/`) turns audio into a voiceprint with `sherpa-onnx-node` + a WeSpeaker ONNX model and compares it with the owner's saved voiceprint. `app.js` owns the voiceprint store and exposes `novi.checkVoice(audio)`; the wake listener calls it on wake, on follow-ups, and for interrupts while Novi speaks. Interrupt = `novi.stopSpeaking()` (kills the laptop voice process, tells laptop pages `stop_speaking`) + a follow-up capture.

**Tech Stack:** Node ESM, Vitest, `sherpa-onnx-node@1.13.8` (Apache-2.0), React UI.

**Spec:** `docs/superpowers/specs/2026-10-08-novi-speaker-check-design.md`

## Global Constraints
- No Python. No Claude. No paid services. Novi never downloads the model by itself.
- Default model path `models/speaker/wespeaker_en_voxceleb_resnet34.onnx`; override `NOVI_SPEAKER_MODEL`. `models/speaker/*.onnx` is gitignored (≈26 MB).
- Voiceprint file `data/voiceprint.json` (`{ voiceprint, clipCount, selfScores, strictness, enabled, model, createdAt }`); the voiceprint numbers never leave the server (GET returns no numbers).
- Enrollment clips: `data/voice-samples/hey-novi/*.wav` (16 kHz mono 16-bit, read with `readWavInt16` from `server/voice/wakeword/detector.js`). Fewer than 5 usable clips → error "Record at least 5 'Hey Novi' clips first."
- Suggested strictness = round2(max(0.25, minSelfScore − 0.1)). Strictness accepted range 0.1–0.9.
- Wake check window: last 1.5 s of mic audio (19 frames of 80 ms).
- Interrupt level = `NOVI_WAKEWORD_INTERRUPT_THRESHOLD` if set, else current wake threshold + 0.15.
- After interrupt: follow-up capture with `waitMs: 8000`. Running tasks are never cancelled.
- Never deaf: missing model, missing voiceprint, switch off, a dimension mismatch, or any error in the check → audio is let through.
- Laptop wake mic only; phone/browser talk button unchanged. Approvals/PIN/passkeys unchanged.
- Settings changes (learn / switch / strictness) are laptop-only (`isLocal(req)`), like the wake-samples routes.
- CLAUDE.md rules: TDD; full suite green before each push; this session pushes to branch `claude/ecstatic-brahmagupta-0bsazo` (user's choice).

## Review Focus
1. Owner on a bad day (cold, far from mic) → still accepted on most tries: suggested strictness sits ≥0.1 below the owner's worst clip (Task 2 test).
2. Novi's own voice from the laptop speakers scoring above the wake level → must not interrupt unless the voice check also passes (Task 3 test).
3. A corrupt / wrong-format clip in the hey-novi folder → skipped, enrollment still works from the rest (Task 2 test).
4. Model file swapped after enrolling (voiceprint length ≠ model dim) → check off + "learn your voice again" status, never a crash or deafness (Task 5 test).
5. `stop()` with nothing playing, or twice in a row → no throw, no extra process (Task 4 test).

---

### Task 1: Speaker verifier

**Files:**
- Create: `server/voice/speaker/verifier.js`
- Modify: `package.json` (add `"sherpa-onnx-node": "1.13.8"` to dependencies, run `npm install`), `.gitignore` (add `models/speaker/*.onnx`)
- Test: `tests/server/speakerVerifier.test.js`

**Interfaces:**
- Produces:
  - `cosine(a: ArrayLike<number>, b: ArrayLike<number>) → number` (0 when either is all-zero or lengths differ)
  - `loadSpeakerVerifier({ modelPath, load?, exists? = fs.existsSync }) → Promise<{ verifier: Verifier|null, status: 'ready'|'no-model'|'error', error?: string }>`
  - `Verifier = { dim: number, model: string /* basename */, embed(audio: Int16Array) → Float32Array, score(a, b) → number /* cosine */ }`
  - Default `load(modelPath)`: `const { SpeakerEmbeddingExtractor } = (await import('sherpa-onnx-node')).default ?? …; return new SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, provider: 'cpu', debug: 0 })`. `embed`: `stream = ex.createStream(); stream.acceptWaveform({ sampleRate: 16000, samples: Float32Array(audio/32768) }); stream.inputFinished(); if (!ex.isReady(stream)) throw new Error('clip too short'); return ex.compute(stream)`.

- [ ] **Step 1: Write failing tests** — `cosine([1,0],[1,0])===1`, `cosine([1,0],[0,1])===0`, `cosine([1,2],[1])===0`; missing file → `{ verifier: null, status: 'no-model' }` and `load` not called; `load` throws → `{ verifier: null, status: 'error', error: <message> }`; with a fake extractor (`dim: 3`, `createStream` returning a stream that records `acceptWaveform` args, `isReady → true`, `compute → Float32Array[1,2,3]`) `embed(Int16Array[16384])` passes `sampleRate: 16000` and samples `[0.5]` and returns `[1,2,3]`; `isReady → false` makes `embed` throw.
- [ ] **Step 2: Run** `npx vitest run tests/server/speakerVerifier.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `server/voice/speaker/verifier.js`; add dependency + gitignore line.
- [ ] **Step 4: Run** the test file → PASS.
- [ ] **Step 5: Commit** `feat(voice): speaker verifier (sherpa-onnx voiceprints)`.

### Task 2: Enrollment + voiceprint store

**Files:**
- Create: `server/voice/speaker/enroll.js`
- Test: `tests/server/speakerEnroll.test.js`

**Interfaces:**
- Consumes: `Verifier`, `cosine` (Task 1); `readWavInt16` (detector.js).
- Produces:
  - `readClips(dir) → Int16Array[]` (all `*.wav`, sorted; unreadable/wrong-format files skipped)
  - `enrollVoice({ verifier, clips }) → { voiceprint: number[], clipCount, selfScores: [min, max], suggested }` — clips whose `embed` throws are skipped; < 5 usable → throws "Record at least 5 'Hey Novi' clips first."; voiceprint = L2-normalized mean of L2-normalized embeddings; self score of clip i = cosine(clip i, normalized mean of the others); all numbers rounded to 3 decimals except `suggested` (2).
  - `createVoiceprintStore({ file }) → { get() → saved|null, save(enrollment, { model }) → summary, update({ enabled?, strictness? }) → summary, summary() → { learned: boolean, enabled, clipCount, selfScores, strictness, model } }` — `save` sets `strictness = suggested`, `enabled = true`, `createdAt` ISO; `update` throws "Strictness must be between 0.1 and 0.9." outside range; summary never includes `voiceprint`.

- [ ] **Step 1: Write failing tests** with a fake verifier mapping clip → fixed vector:
  - 6 near-identical clips → `clipCount 6`, `selfScores[0] > 0.9`, `suggested === round2(max(0.25, min − 0.1))` and `suggested <= selfScores[0] − 0.1` (Review Focus 1).
  - 4 clips → throws the exact message; 6 clips where 2 `embed` throw → throws (only 4 usable).
  - `readClips` on a temp dir with 5 valid WAVs (`encodeWav`) + one `bad.wav` with junk bytes → returns 5 (Review Focus 3).
  - store: `save` then `get().voiceprint` length matches, `summary()` has no `voiceprint` key, `update({ strictness: 0.95 })` throws, `update({ enabled: false }).enabled === false`, file survives a new store instance.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `enroll.js`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(voice): learn the owner's voice from Hey Novi clips`.

### Task 3: Listener — voice check, rejected wakes, interrupt

**Files:**
- Modify: `server/voice/wakeword/listener.js`
- Test: `tests/server/wakeListener.test.js` (add cases; reuse its fake recorder/detector helpers)

**Interfaces:**
- New `createWakeListener` options: `checkSpeaker = () => true` (`(audio: Int16Array) → boolean | Promise<boolean>`), `interruptThreshold = null` (absolute level; null → `threshold + 0.15` using the live threshold), `onInterrupt = () => {}`, `onRejected = () => {}` (`({ score }) → void`).
- New method: `setSpeaking(on: boolean)` — on → deaf until turned off (on top of `followUp`'s `deafUntil`); off → `deafUntil = clock + 300` (short tail for the room echo).
- Produces for Task 5: `listener.setSpeaking`, `onInterrupt`, `onRejected`.

Behaviour (keep a rolling buffer of the last 19 frames, always, before any early return except `capturing`):
- Idle + score ≥ threshold + cooldown passed → `await safeCheck(last 1.5 s)`; true → wake as today; false → `onRejected({ score })`, `cooldownUntil = clock + cooldownMs`, stay idle.
- Deaf (speaking or `clock <= deafUntil`) + score ≥ interrupt level + cooldown passed + `safeCheck` true → clear speaking/deaf, `onInterrupt()`, start a follow-up capture `{ waitMs: 8000, followUp: true }`, cooldown. Otherwise ignore the frame as today.
- `finish()` for a follow-up with speech: `safeCheck(command audio)` false → `onNoCommand({ followUp: true })` instead of `onCommand`.
- `safeCheck`: `try { return Boolean(await checkSpeaker(audio)) } catch { return true }`.

- [ ] **Step 1: Write failing tests:**
  - owner (`checkSpeaker → true`) wakes as before; `checkSpeaker → false` → no `onWake`, `onRejected` called once with the score.
  - `checkSpeaker` throws → wakes (never deaf).
  - check receives ≤ 1.5 s of audio (≤ 19 × 1280 samples).
  - follow-up speech from another voice → `onNoCommand({ followUp: true })`, no `onCommand`.
  - `setSpeaking(true)` + score = threshold + 0.1 → no interrupt; score = threshold + 0.2 with owner → `onInterrupt` once and the next spoken frames become a follow-up `onCommand`; same high score with `checkSpeaker → false` → no interrupt (Review Focus 2).
  - `interruptThreshold: 0.9` + score 0.6 while speaking → no interrupt.
  - `setSpeaking(false)` → normal wake works again after 300 ms.
- [ ] **Step 2: Run** `npx vitest run tests/server/wakeListener.test.js` → new cases FAIL, old pass.
- [ ] **Step 3: Implement** in `listener.js` (make `finish` async; `step` already awaited per frame).
- [ ] **Step 4: Run** → PASS (all old cases too).
- [ ] **Step 5: Commit** `feat(wake): only the owner wakes Novi; Hey Novi interrupts speech`.

### Task 4: Laptop voice `stop()`

**Files:**
- Modify: `server/voice/localSpeaker.js`
- Test: `tests/server/localSpeaker.test.js` (add cases; reuse its fake `run`)

**Interfaces:**
- Produces: the returned `say` function gets `say.stop()`: increments a generation counter (queued lines from an older generation return without sending), kills the current child (`child.kill()`; existing `died` resolves its waiters), sets `voice = null`, then starts a fresh process in the background (`voice = start()`).

- [ ] **Step 1: Write failing tests:** say A, say B, `stop()` before A's "done" → the first child was killed, B never written to any child's stdin, a second child spawned; `say C` afterwards writes to the new child; `stop()` with nothing ever said → no throw, at most one spawn; `stop()` twice → no throw, no third process (Review Focus 5).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(voice): stop the laptop voice mid-reply`.

### Task 5: Wiring — app routes, checkVoice, stopSpeaking, service, health

**Files:**
- Modify: `server/app.js`, `server/voice/wakeword/service.js`
- Test: `tests/server/speakerCheck.test.js` (new, app-level with supertest like the other route tests), `tests/server/wakeService.test.js` (add cases)

**Interfaces:**
- Consumes: Tasks 1–4.
- `createNovi` returns additionally:
  - `setSpeakerVerifier({ verifier, status })`
  - `checkVoice(audio: Int16Array) → { ok: boolean, score: number|null }` — `ok: true, score: null` when no verifier / not learned / disabled / `voiceprint.length !== verifier.dim` (status then `'relearn'`); else `score = verifier.score(verifier.embed(audio), voiceprint)`, `ok = score >= strictness`; any throw → `{ ok: true, score: null }`.
  - `stopSpeaking()` — `localSpeaker?.stop?.()` + `broadcast({ type: 'stop_speaking' })`.
- App wraps every local-speaker call so the listener knows Novi is talking: a counter; first start → `wakeTools?.setSpeaking?.(true)`, last finish → `setSpeaking(false)`.
- Routes (all writes laptop-only, 403 otherwise):
  - `GET /api/voiceprint` → `{ available: status === 'ready', status, ...store.summary() }`
  - `POST /api/voiceprint/learn` → `enrollVoice({ verifier, clips: readClips(heyNoviDir) })`, `store.save(result, { model: verifier.model })`, return summary; 409 "Speaker model not installed." without verifier; 400 with the enrollment error message.
  - `PUT /api/voiceprint` `{ enabled?, strictness? }` → `store.update(...)`, return summary; 400 on bad strictness.
  - `POST /api/wake-samples` response gains `voiceMatch` (`checkVoice(audio).score`, null when off).
  - `/api/health` gains `speakerCheck: 'on' | 'off' | 'no-model' | 'error' | 'relearn'` (`off` = model ready but not learned or disabled).
- `service.js`: after the detector loads, `novi.setSpeakerVerifier?.(await loadSpeakerVerifier({ modelPath: env.NOVI_SPEAKER_MODEL || models/speaker/wespeaker_en_voxceleb_resnet34.onnx }))`; listener gets `checkSpeaker: (a) => novi.checkVoice ? novi.checkVoice(a).ok : true`, `interruptThreshold: env.NOVI_WAKEWORD_INTERRUPT_THRESHOLD ? Number(...) : null`, `onRejected` (log `[wake] not the owner's voice` + score when `NOVI_WAKEWORD_DEBUG`), `onInterrupt` (log `[wake] interrupted`, `novi.stopSpeaking?.()`, `novi.broadcast({ type: 'wake' })`); `setWakeTools` adds `setSpeaking: (on) => current?.listener.setSpeaking(on)`. Startup log line adds `voice check: on/off/no model`.

- [ ] **Step 1: Write failing tests** (fake verifier `{ dim: 3, model: 'fake.onnx', embed: audio → vector by first sample, score: cosine }`, temp data dir with 6 encoded clips):
  - learn → 200 summary with `learned: true`, no `voiceprint` key; non-local request → 403; no verifier → 409.
  - `checkVoice` owner audio → ok true with score ≥ strictness; other audio → ok false; disabled → ok true, score null; voiceprint of length 2 with dim 3 → ok true and health `speakerCheck: 'relearn'` (Review Focus 4); `embed` throws → ok true.
  - `PUT /api/voiceprint { strictness: 2 }` → 400.
  - `stopSpeaking()` calls the fake local speaker's `stop` and broadcasts `stop_speaking`.
  - health: no verifier → `'no-model'`; learned + enabled → `'on'`.
  - service test: with a fake novi exposing `checkVoice → { ok: false }`, a wake score above threshold does not broadcast `wake`.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement** in `app.js` and `service.js`.
- [ ] **Step 4: Run** both files → PASS, then `npx vitest run` → all green.
- [ ] **Step 5: Commit** `feat(voice): voiceprint routes, owner check and interrupt wiring`.

### Task 6: UI + docs

**Files:**
- Modify: `src/lib/useNovi.js` (case `'stop_speaking'` → `stopSpeaking()` from `src/lib/voice.js`), `src/components/WakeTraining.jsx`, Settings → System component that renders `/api/health` (find with `grep -rn "lastBackup" src`), `README.md`, `CLAUDE.md`
- Test: `npm run build` (no UI unit tests exist) + full suite

**UI (WakeTraining.jsx), using `GET/PUT /api/voiceprint` and `POST /api/voiceprint/learn`:**
- "Learn my voice" button → shows "Learned from N clips · your match 0.62–0.81 · strictness 0.45" or the error text.
- "Only my voice" checkbox (`enabled`) and a strictness slider 0.1–0.9 step 0.01 (saved on release).
- Each practice-clip result line shows `voice match 0.74` when `voiceMatch` is not null.
- When `status === 'no-model'`: one line "Voice check needs the speaker model — see README (Voice check)."
- System panel: "Voice check: on / off / model missing / error / learn your voice again".

**Docs:**
- README "Voice check" section: download `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx` into `models/speaker/` (the release tag really is spelled "recongition"), restart Novi, Settings → "Hey Novi" → Learn my voice; env `NOVI_SPEAKER_MODEL`, `NOVI_WAKEWORD_INTERRUPT_THRESHOLD`; say "Hey Novi" to interrupt.
- CLAUDE.md "Current focus": one dated line (2026-10-08) summarizing the feature, files, env vars, and the new test count.

- [ ] **Step 1: Implement** the UI + docs.
- [ ] **Step 2: Run** `npm run build` → succeeds; `npx vitest run` → all green (note the count).
- [ ] **Step 3: Commit** `feat(ui): Learn my voice, voice-check status, stop_speaking; docs`.
- [ ] **Step 4: Push** `git push -u origin claude/ecstatic-brahmagupta-0bsazo` and update PR #1's description to list what was built and the user's setup steps.
