# Novi Automations + Project Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, per CLAUDE.md). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nightly Drive backup, a self-filling "Novi log" Google Sheet, repeating rules by voice, "what's next on <project>?" with an on-open reminder, and a richer morning briefing that also notifies the phone.

**Architecture:** Extend existing plugins (`backup`, `reminders`, `briefing`, `github`) and add two (`sheets-log`, `projects`). Shared core helpers: `server/daily.js` (once-a-day job with catch-up), `server/laptop/activeWindow.js` (foreground window title), Google `drive.file` scope + non-JSON bodies in `runtime.google.call`.

**Tech Stack:** Node ESM, Google Drive v3 / Sheets v4 REST, GitHub REST, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-novi-automations-design.md`

## Global Constraints
- Scheduled jobs make no AI calls; the only AI call is the project summary, private provider (Groq) only, `details.sensitive = true`.
- Google scope added: exactly `https://www.googleapis.com/auth/drive.file`. Never list, read or delete Drive files Novi didn't create.
- Drive keeps the last 7 `novi-data-*.zip` in folder "Novi backups"; upload time default 02:30 (`NOVI_PLUGIN_BACKUP_DRIVE_TIME`).
- Sheet name "Novi log", tabs `GitHub`, `Study`, `Novi`. GitHub row job 23:50, Novi stats 23:55.
- Rule actions may only run read-only tools (via `runtime.callTool`, which already refuses approval-needing tools).
- Repeats: `daily`, `weekdays`, `weekly:<day,...>` (mon..sun), `hourly:<n>` (n ≥ 1, fires only 08:00–22:00).
- Project open notice: once per project per day, foreground check every 30 s, editors: VS Code, Cursor, Antigravity, Kiro.
- No commits by the executor (CLAUDE.md); suite green after every task.

## Review Focus
- Laptop asleep at 02:30 and 23:50 → each daily job runs once on wake, not twice, and the Sheets row for the missed day uses that day's date. Test in Task 1 + Task 4.
- Google not connected / Drive or Sheets API disabled → a clear "turn on …/reconnect" message, scheduled job logs once and doesn't crash the plugin. Test in Task 2 + Task 4.
- "every Monday and Thursday at 7 pm" said by voice → `weekly:mon,thu` with the right next times across a week boundary. Test in Task 3.
- A project with no git repo / no CLAUDE.md → summary still answers (from whatever exists), no throw. Test in Task 5.
- Groq down during "what's next" → raw open items listed without AI (never another provider). Test in Task 5.

---

### Task 1: Shared helpers — daily jobs, Google non-JSON bodies, drive.file scope
**Files:** Create `server/daily.js`; modify `server/google/api.js`, `server/google/oauth.js`; tests `tests/server/daily.test.js`, `tests/server/googleApi.test.js`, `tests/server/oauth.test.js`.
**Produces:**
- `everyDayAt({ time: 'HH:MM', run: (day: 'YYYY-MM-DD') => Promise, stateFile, now = () => new Date(), tickMs = 60_000 }) -> { start(), stop(), tick() }` — `tick()` runs `run(day)` once when local time ≥ time and `lastDay` (in stateFile) < today; after a missed day it runs once for **yesterday's** date too if yesterday was never run (max one catch-up).
- `runtime.google.call(account, url, { method, body, headers, raw })`: when `raw: true` the body is sent as-is with the given headers (no JSON content-type); disabled-API message names "Google Drive API" / "Google Sheets API" for those URLs.
- `GOOGLE_SCOPES` includes `drive.file`.
- [ ] Tests: `runs once at the time`, `does not run before the time`, `catches up yesterday once after a missed day`, `raw multipart body keeps its own content-type`, `drive/sheets disabled message`, `scopes include drive.file`.
- [ ] FAIL → implement → PASS → full suite.

### Task 2: Drive backup (extend `plugins/backup`)
**Files:** Create `plugins/backup/drive.js`; modify `plugins/backup/index.js`, manifest; test `tests/server/backupDrive.test.js`.
**Consumes:** Task 1 `everyDayAt`, `runtime.google.call(..., { raw })`.
**Produces:** `createDriveUploader({ google, stateFile })` → `{ upload(filePath) -> { id, name }, prune(keep = 7) }`; folder lookup/creation `files.create` mimeType `application/vnd.google-apps.folder` name "Novi backups" (id cached in `data/backup/drive.json`); upload `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart` with `multipart/related; boundary=…`; prune lists `'<folderId>' in parents and trashed=false and name contains 'novi-data-'` and deletes oldest beyond 7.
- [ ] Tests: creates folder once then reuses id; multipart body has metadata (name, parents) + zip bytes; prune deletes only `novi-data-*.zip` beyond 7 oldest-first; `backup_now({ drive: true })` uploads newest local zip; `backup_status` shows last Drive backup; disabled API → friendly error, job logs and continues.
- [ ] FAIL → implement (service: `everyDayAt` at 02:30 uploads newest zip then prunes; failure stored in `data/backup/drive.json` as `lastError`) → PASS → suite.

### Task 3: Rules by voice (extend `plugins/reminders`)
**Files:** modify `plugins/reminders/parse.js`, `index.js`, `store.js`, `scheduler.js`; tests `tests/server/remindersParse.test.js`, `tests/server/remindersPlugin.test.js`.
**Produces:** `parseRepeat(text) -> null | 'daily' | 'weekdays' | 'weekly:mon,thu' | 'hourly:2'`; `nextOccurrence(at, repeat)` handles weekly/hourly (hourly skips to 08:00 next day when past 22:00); reminder field `action: { tool, params }`; `reminder_add` params gain `repeat` (any of the above or plain words, parsed by `parseRepeat`) and `action_tool` (+ `action_params` object). On fire with action: `await runtime.callTool(tool, params)` → say the result text (first 300 chars); refused/failed → say "I couldn't run <tool>: <reason>".
- [ ] Tests: `parseRepeat('every Monday and Thursday')` → `weekly:mon,thu`; `('every 2 hours')` → `hourly:2`; `('every weekday')` → `weekdays`; next times across week boundary; hourly respects 08–22; action runs a read-only tool and speaks result; action naming an approval-needing tool is refused and says so; `reminder_list` shows "every Mon, Thu".
- [ ] FAIL → implement → PASS → suite.

### Task 4: Sheets log (new `plugins/sheets-log`) + GitHub activity tool
**Files:** Create `plugins/sheets-log/index.js`, `openclaw.plugin.json`; modify `plugins/github/index.js` (+manifest); tests `tests/server/sheetsLogPlugin.test.js`, `tests/server/githubPlugin.test.js`.
**Consumes:** Task 1.
**Produces:**
- GitHub tool `github_activity({ date: 'YYYY-MM-DD' })` (read-only) → `{ commits: [{ repo, count }] }` via `GET /search/commits?q=author:<login>+committer-date:<date>&per_page=100`, grouped by repo.
- Sheet created once (`POST https://sheets.googleapis.com/v4/spreadsheets` with 3 sheets + header rows), id in `data/sheets-log.json`; append via `values/<Tab>!A1:append?valueInputOption=USER_ENTERED`.
- Tools: `study_log({ topic, hours?, minutes?, date? })` → row `[date, topic, hours (2 decimals)]`; `sheets_log_link()` → URL (screen only).
- Jobs: 23:50 GitHub rows `[date, repo, count]` (one row "none" when zero); 23:55 Novi row `[date, questions, coding tasks done, coding tasks failed]` — questions = lines in `data/long-term-memory/conversations/<date>.jsonl`, tasks from `runtime.memory` tasks with that date. (Ruling vs spec: reminders/approvals counts dropped — no reliable source; counts only, never text.)
- [ ] Tests: sheet created once and reused; study_log "45 minutes" → 0.75; GitHub rows grouped per repo and "none"; Novi row counts only (no text from the log); missed night writes yesterday's date; Google not connected → message, no throw.
- [ ] FAIL → implement → PASS → suite.

### Task 5: Project memory (new `plugins/projects`) + active window helper
**Files:** Create `plugins/projects/index.js`, `plugins/projects/sources.js`, manifest, `server/laptop/activeWindow.js`; modify `server/app.js` (`runtime.activeWindowTitle`, `runtime.privateComplete`); tests `tests/server/projectsPlugin.test.js`, `tests/server/projectSources.test.js`.
**Produces:**
- `gatherSources({ dir, run, tasks }) -> { commits: string[], notes: string, openItems: string[], todos: string[], lastTasks: string[], head: string|null }` — `git log --since=14.days --pretty=%s -n 15`, `git rev-parse HEAD`, first 4 KB of CLAUDE.md/AGENTS.md/README.md, unchecked `- [ ]` (max 20) from newest `docs/superpowers/plans/*.md`, `git grep -n -E "TODO|FIXME"` (max 20); all `execFile`, any failure → empty field.
- `runtime.privateComplete(prompt) -> string` — Groq only (router purpose `fast` restricted to `privateProviders`); throws if unavailable.
- Tool `project_next({ project? })` (default: project of last coding task) → 2–3 sentences "Last time: … Still open: …" (max 3 items), cached in `data/projects/<name>.json` keyed by HEAD + sources hash; Groq failure → "Still open: <first 3 open items>" without AI. `details.sensitive = true`.
- `activeWindowTitle() -> Promise<string>` (PowerShell GetForegroundWindow/GetWindowText, hidden, 5 s timeout).
- Service: every 30 s, title matches `/(Visual Studio Code|Cursor|Antigravity|Kiro)/` and contains a remembered project name → once per project per day `runtime.say(...)` on the laptop (`kind: 'reminder'` not used: speak only, no push).
- [ ] Tests: sources from a temp git repo (2 commits, CLAUDE.md, a plan with `- [ ]` items, a TODO line); no-git folder → empty fields, no throw; cache reused when HEAD unchanged, recomputed after a new commit; Groq-down fallback lists raw items; open notice once per day per project; title "app.js - NOVI CONTEXT - Visual Studio Code" matches project "NOVI CONTEXT".
- [ ] FAIL → implement → PASS → suite.

### Task 6: Morning briefing upgrade + docs
**Files:** modify `plugins/briefing/index.js`; tests `tests/server/briefingPlugin.test.js`; `README.md`, `CLAUDE.md`.
**Consumes:** Task 2 (`backup_status` lastError), Task 5 (`project_next` cached).
- Adds sources: `['projects', 'project_next', {}]` (cached summary only; skip if none) and Drive backup failure line from `backup_status`; after speaking, `runtime.notify({ kind: 'briefing' })`.
- [ ] Tests: briefing includes "where you left off" text when cached; backup failure line appears only when lastError set; notify called once with kind briefing.
- [ ] FAIL → implement → PASS → suite; README section "Automations" (Drive/Sheets setup: enable Drive API + Sheets API, reconnect Google); CLAUDE.md state.
- [ ] Live (needs user): enable APIs, reconnect Google, `backup_now drive`, "log 1 hour of DSA", "what's next on NOVI?".
