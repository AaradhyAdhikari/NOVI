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
- **Next:** reminders & timers plugin — approved design in `docs/superpowers/specs/2026-10-04-novi-reminders-design.md`. After that: long-term memory plugin; then Novi's own browser + LeetCode.
