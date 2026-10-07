# Novi — project guide for Claude

Novi is a voice-first personal AI companion that runs on the user's Windows laptop (vision: `NOVI CONTEXT.txt`, user-facing docs: `README.md`).

## Hard rules
- **No Claude usage inside Novi.** Novi's brain and its coding agent run on free Groq/Gemini keys. Claude Code support exists but stays off (`NOVI_CODER=claude` only when the user asks). Never run the real `claude` CLI in tests; use `tests/fixtures/fake-claude.mjs`.
- **Keep Claude usage low while building:** work inline (no subagents), read only the files you need, keep tool output short (redirect long logs to a file and read the tail).
- **Every feature is a plugin** in `plugins/<id>/` written in OpenClaw's plugin shape (see `docs/PLUGINS.md`). Novi will later move onto OpenClaw via one adapter; don't put feature logic in `server/` core unless it's a shared service exposed through `api.runtime`.
- Anything that sends, posts, changes or deletes needs an approval (`before_tool_call` → `requireApproval` with `severity: 'warning'`; `'critical'` = screen-only). Private data results set `details.sensitive = true` (keeps the turn on Groq).
- TDD: write the test, watch it fail, implement, watch it pass, run the full suite. Work directly on `main`.
- **The user makes the commits** (so they count on their GitHub): do NOT `git commit` or `git push`. When a piece of work is done and the suite is green, tell the user to double-click **`Commit and Push.cmd`** (asks for a message, commits everything except `NOVI CONTEXT.txt`/`.env`/`data/` under their name, pushes the current branch) and suggest a commit message.
- Never print or commit secrets (`.env`, `data/`). Check `.env` only for names/shapes.

## Working with Antigravity (2026-10-07)
- Hand small, well-specified tasks (extra tests from a spec, boilerplate, UI polish, docs, mechanical edits) to the Antigravity IDE agent (free tier) with `tools/antigravity/handoff.js`; keep design, security/approvals, brain/voice logic and all reviews. Guide: `docs/ANTIGRAVITY.md`.
- The prompt must be typed into the Antigravity IDE Agent panel (screen control); `antigravity chat` does not reach the agent. Always review the diff and run the full suite after a handoff.

## Layout
- `server/` — core: `brain/` (router Groq⇄Gemini, agent loop), `plugins/` (sdk, host, builtin wrapper), `claude/` + `coder/` (coding tasks), `accounts/` (registry, DPAPI secrets, resolution), `google/` (OAuth, Gmail), `laptop/`, `tools/` (built-in tool registries), `app.js` (HTTP/WebSocket + `api.runtime`), `index.js` (startup, loads `plugins/`).
- `plugins/` — `clock` (example), `github` (device-flow GitHub).
- `src/` — React UI (push-to-talk, transcript, task panel, approval cards, Settings).
- `docs/superpowers/specs|plans/` — designs and plans; `docs/PLUGINS.md` — plugin guide.
- `tests/server/` — Vitest; `tests/fixtures/`.

## Commands (Windows: PowerShell blocks `npm.ps1`, so use `npm.cmd` or Bash)
- Tests: `npx vitest run` (all) or `npx vitest run tests/server/<file>.test.js`
- Build UI: `npm run build` · Run: `npm.cmd start` or double-click `Start Novi.cmd` → https://localhost:3001
- Live checks without disturbing the user's instance: `NOVI_PORT=3002 node --env-file-if-exists=.env server/index.js`, then talk to `wss://localhost:3002/ws` (send `{type:'user_message', text}`, read `chat` entries with role `novi`).

## State (2026-10-04)
- Done: MVP (voice, Groq/Gemini brain with fallback, Novi Coder, approvals, phone pairing), laptop basics (websites, YouTube by position, apps), Gmail multi-account, plugin system, GitHub plugin (needs `NOVI_PLUGIN_GITHUB_CLIENT_ID` in `.env`; user will set it up later). 238 tests green.
- Local `main` has 1+ unpushed commits (GitHub plugin) — ask the user before pushing.
- OpenClaw trial (2026-10-03): stable 2026.8.35 installed globally, profile `~/.openclaw-novi`; not adopted yet (native-Windows rough edges, approval flow unproven). Re-check later.
## Current focus (2026-10-05)
- Voice-first upgrade is done (hands-free "Hey Novi" with sound-alike matching, spoken follow-ups, "use Claude instead" choice, Whisper vocabulary hint). Live voice reliability still being tuned with the user.
- Reminders & timers plugin is done (`plugins/reminders`; plugins can now `api.registerService` and use `runtime.say` / `runtime.dataDir`). 277 tests green.
- Speech layer started (2026-10-07): `server/voice/speechEngine.js` tries providers in order — `providers/groqWhisper.js` (main) then `providers/geminiStt.js` (backup, free keys); verified live. TTS is still the browser's `speechSynthesis` (`src/lib/voice.js`). Talk button uses Silero VAD (`src/lib/vadRecorder.js`, lazy chunk; model/runtime served at `/vad/` from node_modules): hold or tap-to-talk, 16 kHz WAV, silence never sent. Settings → Voice test records 24 phrases (en/hi/mr/Hinglish) to `data/voice-samples/` for the STT benchmark. `plugins/weather` (Open-Meteo, no key; home city `NOVI_PLUGIN_WEATHER_PLACE`). "Hey Novi" is always on (ear toggle removed; watchdog + network backoff in `src/lib/handsFree.js`; Brave unsupported). User recorded all 24 voice-test phrases (VAD works on real mic). Server-side wake word built (2026-10-07): openWakeWord pipeline in Node (`server/voice/wakeword/` detector + listener + service; models in `models/wakeword/`, mic via `@picovoice/pvrecorder-node` — no Picovoice account; Picovoice signup rejected Gmail). Starts automatically when `models/wakeword/hey_novi.onnx` exists; then UI disables browser listening (`wakeWord: 'server'`). Env: `NOVI_WAKEWORD_MODEL`, `NOVI_WAKEWORD_MIC` (index or part of name; default = Windows default mic), `NOVI_WAKEWORD_THRESHOLD`. `hey_novi.onnx` NOT trained yet: Colab notebook github.com/alfiedennen/openwakeword-colab-2026 needs runtime version 2026.04 (Py3.12) + T4 GPU; free GPU quota ran out 2026-10-07. Verified live end to end 2026-10-07 with `hey_jarvis_v0.1.onnx` (gitignored) on the default mic: wake → 3 s command → Whisper → weather answer spoken by Windows voice (`server/voice/localSpeaker.js`, used when no page is open). STT retries as English if Whisper guesses a language other than en/hi/mr; quiet commands are volume-normalized; `NOVI_WAKEWORD_DEBUG=1` logs mic level + score. Mic: use the Windows default (AB13X = user's earbuds/headset); TODO follow default-mic changes. 349 tests green.
- **Next: voice intelligence layer** (BHASHINI + Whisper providers, context/vocabulary layer, interpretation log, benchmark, TTS) — Phase 1 report/design: `docs/superpowers/specs/2026-10-05-novi-voice-intelligence-design.md`. Needs the user's approval of the open decisions there and BHASHINI `BHASHINI_USER_ID` + `BHASHINI_API_KEY` in `.env` before Milestone 1.

## Roadmap (agreed with the user 2026-10-04 — build in this order, one fresh session each)
1. **Remote access via Tailscale** — user installs Tailscale on laptop + phone; no code needed for the `https://100.x.y.z:3001` path (cert + allowed origins pick up the Tailscale IP at startup). Do NOT use `tailscale serve` until requests proxied through it are treated as remote (they currently look like localhost and would skip pairing). User chose Tailscale only, **no Telegram**.
2. **Voice-first upgrade (top priority — "everything over voice")**: a dispatcher step that picks the best handler (Groq / Gemini / Novi Coder / Claude Code later / plugin) and, for bigger jobs, says its choice and waits for a spoken yes/no/"use X instead"; hands-free "Hey Novi" wake word (browser-side speech detection so Whisper quota isn't spent on silence); every approval answerable by voice; high-risk approvals by spoken confirmation + short voice PIN instead of screen tap. Needs a spec first.
3. ~~Reminders & timers plugin~~ — done 2026-10-05.
4. **Always-on + permissions**: start Novi at Windows login (scheduled task); one-time per-capability grants (files, commands, apps, browser, screen control) remembered and revocable in Settings; "always allow" for medium actions by category; deletes/sends/payments still confirm (voice PIN); admin changes go through Windows UAC (never bypass).
5. **Novi's own browser + browsing agent**: LeetCode ("today's problem", stats) and other sites; assisted sign-ups (fill real profile details, generate password into the user's password manager, prefer "Sign in with Google"; pause for CAPTCHA / email codes — never bypass CAPTCHAs, never fake identities).
6. **n8n plugin** + first automations (data-only, zero LLM calls): morning-briefing bundle, nightly backup of `data/` to Drive, GitHub watchers, page/price watchers, Sheets logging, apps without a Novi plugin (Calendar, Spotify, Notion).
7. **Screen control plugin** (computer use) for apps without APIs.
8. Later: long-term memory plugin; Graphify-style code map for Novi Coder on big repos; re-test OpenClaw (WSL2) for the adapter move.
