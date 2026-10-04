# Novi — project guide for Claude

Novi is a voice-first personal AI companion that runs on the user's Windows laptop (vision: `NOVI CONTEXT.txt`, user-facing docs: `README.md`).

## Hard rules
- **No Claude usage inside Novi.** Novi's brain and its coding agent run on free Groq/Gemini keys. Claude Code support exists but stays off (`NOVI_CODER=claude` only when the user asks). Never run the real `claude` CLI in tests; use `tests/fixtures/fake-claude.mjs`.
- **Keep Claude usage low while building:** work inline (no subagents), read only the files you need, keep tool output short (redirect long logs to a file and read the tail).
- **Every feature is a plugin** in `plugins/<id>/` written in OpenClaw's plugin shape (see `docs/PLUGINS.md`). Novi will later move onto OpenClaw via one adapter; don't put feature logic in `server/` core unless it's a shared service exposed through `api.runtime`.
- Anything that sends, posts, changes or deletes needs an approval (`before_tool_call` → `requireApproval` with `severity: 'warning'`; `'critical'` = screen-only). Private data results set `details.sensitive = true` (keeps the turn on Groq).
- TDD: write the test, watch it fail, implement, watch it pass, run the full suite. Work on a feature branch; commit with the `Co-Authored-By` line. **Ask before pushing** to GitHub (remote `origin`, repo AaradhyAdhikari/NOVI).
- Never print or commit secrets (`.env`, `data/`). Check `.env` only for names/shapes.

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
## Roadmap (agreed with the user 2026-10-04 — build in this order, one fresh session each)
1. **Remote access via Tailscale** — user installs Tailscale on laptop + phone; no code needed for the `https://100.x.y.z:3001` path (cert + allowed origins pick up the Tailscale IP at startup). Do NOT use `tailscale serve` until requests proxied through it are treated as remote (they currently look like localhost and would skip pairing). User chose Tailscale only, **no Telegram**.
2. **Voice-first upgrade (top priority — "everything over voice")**: a dispatcher step that picks the best handler (Groq / Gemini / Novi Coder / Claude Code later / plugin) and, for bigger jobs, says its choice and waits for a spoken yes/no/"use X instead"; hands-free "Hey Novi" wake word (browser-side speech detection so Whisper quota isn't spent on silence); every approval answerable by voice; high-risk approvals by spoken confirmation + short voice PIN instead of screen tap. Needs a spec first.
3. **Reminders & timers plugin** — approved design: `docs/superpowers/specs/2026-10-04-novi-reminders-design.md`.
4. **Always-on + permissions**: start Novi at Windows login (scheduled task); one-time per-capability grants (files, commands, apps, browser, screen control) remembered and revocable in Settings; "always allow" for medium actions by category; deletes/sends/payments still confirm (voice PIN); admin changes go through Windows UAC (never bypass).
5. **Novi's own browser + browsing agent**: LeetCode ("today's problem", stats) and other sites; assisted sign-ups (fill real profile details, generate password into the user's password manager, prefer "Sign in with Google"; pause for CAPTCHA / email codes — never bypass CAPTCHAs, never fake identities).
6. **n8n plugin** + first automations (data-only, zero LLM calls): morning-briefing bundle, nightly backup of `data/` to Drive, GitHub watchers, page/price watchers, Sheets logging, apps without a Novi plugin (Calendar, Spotify, Notion).
7. **Screen control plugin** (computer use) for apps without APIs.
8. Later: long-term memory plugin; Graphify-style code map for Novi Coder on big repos; re-test OpenClaw (WSL2) for the adapter move.
