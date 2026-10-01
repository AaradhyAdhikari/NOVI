# NOVI MVP — Design Spec

Date: 2026-10-01
Status: Draft for review
Source vision: `NOVI CONTEXT.txt`, `README.md`

## 1. Goal

Deliver Novi's signature scenario end to end:

> From the couch, on my phone, I say "Ask Claude to add login to my portfolio project." Novi starts Claude Code on my laptop, narrates progress out loud, asks me before risky actions, and lets me ask "what's Claude doing?", give follow-ups, or say "stop".

Success criteria:

1. Push-to-talk voice from the laptop browser **and** a phone browser on the same Wi-Fi.
2. Novi starts a Claude Code task in a named project, streams narrated progress, accepts follow-up instructions in the same session, and can stop it.
3. Risky actions requested by Claude Code are approved/denied by me via the UI (and announced by voice) according to permission tiers.
4. Novi keeps working when one free LLM provider is rate-limited (automatic fallback).
5. Zero paid API usage: the brain runs on free tiers (Groq, Gemini); coding runs on Claude Code with my Claude Pro login.

## 2. Scope

**In:** voice in/out, conversational brain with tool calling, multi-provider router with key pools + fallback, Claude Code control tool, narrator, permission tiers, JSON-file memory (projects, recent tasks), LAN phone access with pairing code over HTTPS, task feed UI.

**Out (later sub-projects):** laptop basics (open apps/URLs), project git summaries, reminders, remote access outside home Wi-Fi, TV casting, wake word, Ollama/local models, other MCP plugins.

## 3. Architecture

```
 Phone / laptop browser (React UI)
   │  push-to-talk audio, text, approvals   ▲ live events, replies (spoken via browser TTS)
   ▼  WebSocket over HTTPS (device token)   │
 ┌──────────────── Novi server (laptop, Node/Express/ws) ─────┐
 │ voice/stt.js       Groq Whisper: audio → text              │
 │ brain/providers/*  groq.js, gemini.js (+ openrouter etc.)  │
 │ brain/router.js    provider chain, key pools, cooldowns    │
 │ brain/agent.js     conversation loop + tool calling        │
 │ tools/registry.js  tool definitions + risk tier each       │
 │ tools/claudeCode.js  Claude Code process manager           │
 │ narrator.js        Claude events → short spoken updates    │
 │ permissions.js     tier policy + pending-approval queue    │
 │ memory.js          data/memory.json                        │
 │ auth.js            pairing code → device token             │
 └────────────────────────────────────────────────────────────┘
```

Stack: Node 24 (ESM), Express, `ws`, React 19 + Vite (existing scaffold). Server on `https://<lan-ip>:3001`; Vite dev server proxies `/api` and `/ws`.

## 4. Components

### 4.1 Brain: provider router (`brain/router.js`)
- Common interface: `chat({ messages, tools, purpose }) → { text, toolCalls }`, where `purpose` ∈ `fast` (default turns) | `long` (large context / summaries).
- Provider chain configured in `.env`; default order for `fast`: Groq → Gemini → optional extras (OpenRouter, Cerebras, Mistral); for `long`: Gemini → Groq → extras.
- Key pools: `GROQ_API_KEYS=k1,k2` (comma-separated) per provider. Only legitimately owned keys; the design does not encourage multi-account quota evasion.
- On 429/rate-limit: read `retry-after` (default 60s), put that key on cooldown, immediately try the next key, then the next provider.
- On 5xx/network error: retry once, then mark provider unhealthy for 2 minutes after 3 consecutive failures.
- If every provider is unavailable: reply "My AI providers are all rate-limited; try again in N seconds" — Claude Code tasks already running continue unaffected.
- Exposes status (active provider, keys on cooldown) to the UI.

### 4.2 Agent loop (`brain/agent.js`)
- System prompt: Novi persona (brief, spoken-style replies, 1–3 sentences), list of known projects from memory, current task state summary.
- Standard tool-calling loop (max 6 tool rounds per user turn). Conversation history kept in memory, trimmed to last ~20 turns.

### 4.3 Tools (`tools/registry.js`)
Each tool: `{ name, description, schema, tier, run(args, ctx) }`.

| Tool | Tier | Behaviour |
|---|---|---|
| `list_projects` | low | Return known projects |
| `remember_project(name, path)` | medium | Save name→folder (path must exist) |
| `forget_project(name)` | medium | Remove a project |
| `claude_start_task(project, instruction)` | medium | Start Claude Code in project folder |
| `claude_send_message(instruction)` | low* | Follow-up in the current session (*Claude's own actions still gated) |
| `claude_status()` | low | Current narrated state + recent events |
| `claude_stop()` | low | Stop the running task |

One Claude Code task at a time in the MVP.

### 4.4 Claude Code manager (`tools/claudeCode.js`)
- Spawns the Claude Code CLI headless in the project folder: `claude -p <instruction> --output-format stream-json --verbose`, with `--resume <session_id>` for follow-ups. Uses the CLI's existing login (Claude Pro).
- Permission bridge: Novi provides a small MCP server exposing an approval tool, passed via `--mcp-config` + `--permission-prompt-tool`, so every Claude Code permission request is routed to `permissions.js`.
- Parses each JSON line into normalized events: `started`, `thinking/text`, `tool_use` (Read/Edit/Write/Bash…), `tool_result`, `permission_request`, `result` (success/error, cost/turns), `exited`.
- Stop = terminate the process tree (Windows: `taskkill /T /F`). Session id retained so "continue" can resume.
- Exact CLI flags are verified against the installed CLI during implementation (`claude --help`) before coding against them.

### 4.5 Narrator (`narrator.js`)
- Groups raw events into human updates and throttles speech: at most one spoken update per ~8s, always speaks immediately for: permission requests, errors, test failures, task finished.
- Template-based (no LLM call) for routine events: "Reading 4 files in src/auth", "Edited login.jsx", "Running npm test", "Tests: 2 failed". The task's final result summary may use the brain (`long` purpose) if available, otherwise Claude's own final text.

### 4.6 Permissions (`permissions.js`)
Policy applied to both Novi's own tools and Claude Code's requests:

- **Low (auto-allow):** Read, Glob, Grep, LS, web fetch/search, status/stop.
- **Medium (ask):** Edit/Write files, Bash commands not matching high-risk rules, starting a task, remembering a project.
- **High (ask, explicit "Yes, do it" confirm, never auto):** Bash matching `rm -rf`, `del /s`, `Remove-Item -Recurse`, `git push`, `git reset --hard`, `--force`, package publish, anything touching paths outside the project folder.
- Optional per-session "allow edits for this task" toggle (downgrades Edit/Write to auto for the current task only; never affects high tier).
- Pending approval → UI card with Allow/Deny + spoken prompt. Unanswered after 5 minutes → deny. Voice "yes"/"no" answers the most recent pending request (high tier requires the UI button).

### 4.7 Memory (`memory.js`)
`data/memory.json` (gitignored): `{ projects: { name: { path, lastUsed } }, tasks: [{ id, project, instruction, sessionId, status, startedAt, summary }], prefs: {} }`. Atomic writes (write temp file + rename). Viewable and deletable via UI ("Memory" panel) and `forget_project`.

### 4.8 Voice
- Input: push-to-talk button records via `MediaRecorder` (webm/opus) → `POST /api/stt` → Groq Whisper (`whisper-large-v3-turbo`), falling back to the browser Web Speech API if Groq is unavailable. Text input box always available too.
- Output: browser `speechSynthesis` speaks Novi replies and narrator updates; mute toggle.

### 4.9 LAN access & auth (`auth.js`)
- Server serves HTTPS with a self-signed cert generated on first run (stored in `data/certs/`, gitignored), so phone browsers allow microphone access. User accepts the browser warning once.
- Laptop browser on localhost is trusted automatically. Any other device must enter a 6-digit pairing code shown on the laptop UI (rotates every 5 min); success issues a random device token (stored hashed in `data/devices.json`, revocable from the UI).
- All `/api` and WebSocket connections require a valid token or localhost origin.

### 4.10 UI (React)
Single page, mobile-first: big push-to-talk button, conversation transcript, live task feed (narrated updates + expandable raw events), approval cards, provider status chip, memory/devices panel, mute toggle.

## 5. Data flow (example)

1. Voice → `/api/stt` → text → WebSocket `user_message`.
2. Agent → router (Groq) → tool call `claude_start_task(project="portfolio", instruction=…)`.
3. Memory resolves path; unknown project → Novi asks for the folder.
4. Tier medium → approval card + spoken prompt → user allows.
5. Claude Code spawned; events → narrator → WebSocket `task_event` / `speak` to all connected devices.
6. Claude requests `Bash: npm install` → permission bridge → approval card → allow → continues.
7. "What's Claude doing?" → `claude_status` → spoken summary. "Stop" → `claude_stop`.

## 6. Error handling

| Failure | Behaviour |
|---|---|
| Provider rate-limited | Key cooldown → next key → next provider; status chip updates |
| All providers down | Spoken message with wait time; text/approvals/stop still work (stop/status bypass the LLM via quick keyword match) |
| `claude` CLI missing / not logged in | Clear message at startup and on task start with setup instructions |
| Claude Code hits Pro usage limit | Detected from result/error event → spoken "Claude's usage limit was reached, resets at …" |
| Claude process crashes | Task marked failed, last events kept, can resume via session id |
| Project path missing | Ask user to update it |
| Phone disconnects | Task keeps running on laptop; on reconnect the client receives current task state + pending approvals |
| STT fails | Fall back to Web Speech API, then text box |

## 7. Testing

- Unit tests (Vitest): router fallback/cooldown with fake providers, permission tier classification (incl. high-risk Bash patterns), narrator grouping/throttling from recorded event fixtures, stream-json parser, memory atomic writes, pairing/token auth.
- Integration: Claude Code manager against a fake `claude` script that replays a recorded stream-json transcript (no Pro usage in tests).
- Manual end-to-end checklist: laptop voice, phone pairing + voice, start/follow-up/stop a real Claude task on a scratch repo, approval flow, provider fallback by disabling Groq key.

## 8. User prerequisites

1. Install Claude Code CLI and log in with Claude Pro (`claude` → `/login`).
2. Free Groq API key (console.groq.com) and free Gemini API key (aistudio.google.com), pasted into `.env` by the user.
3. Optional extra free providers (OpenRouter, Cerebras, Mistral) — can be added any time.
