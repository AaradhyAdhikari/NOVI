# NOVI — Voice Intelligence Layer — Phase 1 Report & Design

Date: 2026-10-05
Status: **Draft — Phase 1 report, awaiting the user's approval before any code**
Source brief: user's "voice intelligence layer" brief (BHASHINI + Whisper, Hindi/Marathi/Hinglish, context layer, intent, benchmark, TTS).

## Corrections to the brief's assumptions
1. **Novi is not built on OpenClaw.** Novi has its own core; every feature is a plugin in **OpenClaw's plugin shape** (`docs/PLUGINS.md`) so a later move is one adapter. OpenClaw 2026.8.35 is installed (`~/.openclaw-novi`) but was not adopted (native-Windows issues, approval flow unproven). → The voice layer lives in Novi's core and is exposed to plugins via `api.runtime`; the future OpenClaw adapter carries it over.
2. **Intent interpretation by Claude conflicts with the user's standing rule** (no Claude usage inside Novi; Claude Code only when the user explicitly asks). → Use the existing free **Groq** brain (`openai/gpt-oss-120b`) behind an `IntentParser` interface; Claude can be added as an optional parser later.
3. **BHASHINI credentials are not in `.env` yet.** The documented flow needs a **ULCA `userID` and `ulcaApiKey`** (two values), used for the pipeline-config call; the config response returns the inference callback URL and an inference API key used for the compute call.

## 1. Current architecture (what exists)
| Concern | Where | Notes |
|---|---|---|
| Backend / "desktop agent" | `server/` (Node 24, Express + `ws`, HTTPS on 3001) | Runs on the laptop; it *is* the desktop agent |
| Clients | `src/` (React, served by the backend) | Same page on laptop, phone over home Wi-Fi or **Tailscale** (`https://100.78.167.22:3001`); paired with 6-digit code → bearer token |
| Communication | WebSocket `/ws` (`user_message`, `approval`, `speak`, `chat`, `snapshot`…) + REST `/api/*` | Origin check + localhost/token auth (`server/app.js`) |
| AI/model layer | `server/brain/router.js` (Groq ⇄ Gemini, key pools, fallback), `server/brain/agent.js` (tool-calling loop, quick commands) | Privacy rule: `sensitive` results stay on Groq |
| Action layer + permissions | `server/plugins/host.js` (OpenClaw-shaped plugins, `before_tool_call` gates), `server/permissions.js` (tiers, `ApprovalQueue` with voice choices) | **Permissions are enforced outside the LLM** (gates run in code before any tool executes) |
| Coding agents | `server/coder/freeCoder.js` (Novi Coder, Groq), `server/claude/session.js` (Claude Code, opt-in per task: "use Claude instead") | |
| Config/secrets | `.env` via `server/config.js`; account tokens DPAPI-encrypted (`server/accounts/secrets.js`) | |
| **Existing voice** | `server/voice/stt.js` (Groq Whisper `whisper-large-v3-turbo`, vocabulary prompt), `src/components/TalkButton.jsx` (push-to-talk, webm/opus), `src/lib/handsFree.js` + `src/lib/wake.js` (Chrome recognizer for "Hey Novi", sound-alike matching, follow-up window), TTS = browser `speechSynthesis` (`src/lib/voice.js`) | Wake detection and utterance transcription are separate concerns |

## 2–5. Where things go and how they connect
```
Mic (browser) ──16 kHz mono WAV──> POST /api/voice/transcribe ──> VoiceEngine
                                                                  ├─ SpeechProvider: BhashiniProvider (primary)
                                                                  └─ SpeechProvider: WhisperProvider (fallback / English / benchmark)
                                                                  ▼
                                                     SpeechResult { rawText, language, confidence|null, provider, processingMs, audioMs }
                                                                  ▼
                                                     ContextLayer.annotate(raw) → { entities: [{span, candidates:[{value, kind, score}]}] }  (raw text untouched)
                                                                  ▼
                                   Agent (existing) receives raw text + context hints → tool call = structured intent
                                                                  ▼
                                   Plugin gates / ApprovalQueue (permission layer, code-enforced) → plugin execute (action router)
                                                                  ▼
                                   InterpretationLog: raw audio ref → raw text → annotations → intent (tool+args) → action result
```
- **Voice Engine:** `server/voice/engine.js` (provider chain, fallback, timing, logging) — core, exposed to plugins as `runtime.voice`.
- **SpeechProvider abstraction:** `server/voice/providers/` — `speechProvider.js` (interface + `SpeechResult` shape + errors), `bhashini.js`, `whisper.js` (moves today's `stt.js` behind the interface; same behaviour).
- **BHASHINI client:** `server/voice/bhashini/client.js` — pipeline-config call (cached per task+language, ~1 h), compute call, timeouts, response validation, unsupported-language errors; logs never include keys/audio.
- **Context/vocabulary:** `server/voice/context.js` + `data/vocabulary.json` (user terms) merged with built-ins (Novi, OpenClaw, Claude, Claude Code, GitHub, VS Code, FastAPI, WebSocket, Python, JavaScript, TypeScript) and live entities (remembered projects, connected accounts, installed apps). Fuzzy/phonetic candidate matching; **never rewrites the raw transcript**. Vocabulary also feeds provider hints (Whisper prompt; BHASHINI if supported).
- **Intent:** the existing agent's tool calls are the structured intents (schema-validated); add `IntentParser` only for the explicit `coding_task`-style summary used by clarification + logs + benchmark. Clarify when: ASR confidence below threshold (when the provider gives one), an entity has several close candidates ("cloud project" → OpenClaw / Cloud), or a required argument is missing.
- **OpenClaw connection:** none needed now; voice is core + `runtime.voice`. The OpenClaw adapter later maps `runtime.voice` to OpenClaw's media/voice hooks.
- **Hands-free wake word** stays separate (BHASHINI/Whisper are per-utterance REST, not continuous wake detection). Improvement path: Picovoice Porcupine or openWakeWord.

## 6. Files to modify
`server/app.js` (route `/api/voice/transcribe`, runtime.voice), `server/config.js` (BHASHINI + voice settings), `server/brain/agent.js` (accept context hints; clarification), `src/components/TalkButton.jsx` + `src/lib/voice.js` (16 kHz WAV capture, language setting), `src/components/SettingsDrawer.jsx` (voice language, vocabulary editor), `.env.example`, `CLAUDE.md`, `docs/`.

## 7. New files
`server/voice/engine.js`, `server/voice/providers/{speechProvider,bhashini,whisper}.js`, `server/voice/bhashini/client.js`, `server/voice/context.js`, `server/voice/interpretationLog.js`, `server/voice/tts/{ttsProvider,browser,bhashini}.js` (Milestone 6), `src/lib/wavRecorder.js` (AudioWorklet → 16 kHz PCM WAV), `bench/voice/` (dataset manifest, runner, report), tests for each.

## 8. Dependencies
None required for M1–M5 (Node `fetch`, `crypto`; browser AudioWorklet for WAV). Optional later: `ffmpeg` only if a provider needs a format the browser can't produce; IndicConformer would need Python/GPU (benchmark-only, later).

## 9. Security risks & mitigations
- **Keys:** BHASHINI userID/ulcaApiKey + the returned inference key stay server-side (`.env` / memory); never sent to clients; redacted in logs.
- **Audio privacy:** audio leaves the laptop to BHASHINI (Government of India service) or Groq; document it in PRIVACY.md; per-language provider choice; local logs store transcripts (not audio) by default with a retention limit and a Settings switch.
- **No raw execution from voice:** transcripts only reach the agent as text; every action goes through schema-validated tools + code-enforced gates (approvals, high-risk screen-only/PIN). "Delete everything" has no tool that can do it unrestricted.
- **Voice spoofing / bystanders:** high-risk actions keep screen confirmation (voice PIN later); paired-device auth unchanged.
- **Prompt injection via speech:** same defences as text (tool gates, sensitive routing).
- **Failure safety:** provider errors/timeouts → fallback → clear spoken error; never "guess and execute" on low confidence.

## 10. What to implement first (milestones)
1. **M1–M3 together (one session):** `SpeechProvider` interface + `WhisperProvider` (wrap existing) + `BhashiniProvider` (config call + compute call, verified against the official GitBook docs at implementation time) + `VoiceEngine` fallback (BHASHINI → Whisper) + 16 kHz WAV capture + `SpeechResult` + language setting (en / hi / mr; Hinglish → hi model, measured in benchmark). Tests with recorded fixtures; live check needs the user's BHASHINI userID + ulcaApiKey in `.env` (`BHASHINI_USER_ID`, `BHASHINI_API_KEY`).
2. **M2b:** Context layer + vocabulary (annotations only) + InterpretationLog.
3. **M4–M5:** context hints into the agent, clarification on ambiguity/low confidence (structured intent summary).
4. **M7 benchmark:** a recording page in Novi to capture the user's own command set (English, Hindi, Marathi, Hinglish, technical, long, noisy, fast/slow) → runner reports WER/CER, entity accuracy, intent accuracy, latency, failure rate per provider.
5. **M6 TTS:** `TTSProvider` (browser default) + BHASHINI TTS for Hindi/Marathi replies.

## Open decisions for the user
- Approve Groq (not Claude) as the intent interpreter.
- Provide BHASHINI `userID` + `ulcaApiKey` (from the BHASHINI/ULCA profile page) in `.env`.
- Default speaking language for BHASHINI (Hindi model for Hinglish?) — benchmark will confirm.
