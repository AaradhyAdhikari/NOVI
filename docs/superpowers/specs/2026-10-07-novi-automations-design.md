# Novi automations + "where you left off" — design

Date: 2026-10-07 · Roadmap #6/#7 (automations) · Chosen by the user: Drive backup (#1), morning bundle (#4), Sheets logging (#5: GitHub, study hours, Novi stats), rules by voice (#6), and project memory option C. Runs inside Novi (no n8n). Scheduled parts make no AI calls, except the project summary (Groq only, private).

## Goals
1. Novi's `data/` is backed up to the user's Google Drive every night.
2. The morning bundle includes GitHub activity and "where you left off", and arrives as a phone notification too.
3. A Google Sheet "Novi log" fills itself: GitHub commits per day, study hours the user logs by voice, Novi's daily stats.
4. The user creates repeating rules by voice: "every Sunday at 9 PM remind me to…", "every morning at 8 tell me the weather".
5. "Hey Novi, what's next on NOVI?" / "where did I leave off?" answers from the project itself; opening a project in an editor triggers a one-time "last time on NOVI you were…".

## Non-goals
n8n; LeetCode (needs the browser agent); writing to any Drive file Novi didn't create; summaries that send code to a non-private provider.

## Shared pieces
- **`server/daily.js`** — `everyDayAt({ time: 'HH:MM', run, stateFile, now })`: runs once a day at that local time; if the laptop was asleep or Novi off at that time, runs once on the next start/wake (state file holds the last run date). Used by Drive backup and Sheets logging.
- **Google access** — add one scope `https://www.googleapis.com/auth/drive.file` (only files Novi creates/opens; covers both the backup folder and the "Novi log" sheet via the Sheets API). `api.runtime.google` already does signed-in calls with 401 retry. One-time user step: enable Drive API + Sheets API in Cloud Console, reconnect Google. Until then each feature says what to enable instead of failing silently.

## 1. Drive backup (extend `plugins/backup`)
- Nightly 02:30 (`NOVI_PLUGIN_BACKUP_DRIVE_TIME`), upload the newest local zip (the plugin already makes hourly local zips) to a Drive folder "Novi backups" (created once, id stored in `data/backup/drive.json`), multipart upload.
- Keep the last 7 in Drive; delete older ones **only among files in that folder that Novi created** (name pattern `novi-data-*.zip`).
- Tools: `backup_status` adds "last Drive backup: <when>"; `backup_now` gains `{ drive: true }`. No approval (writes only Novi's own files; private data stays in the user's own Drive). Never sent to the AI.
- Failure → feed line + next morning's bundle mentions "Drive backup failed: <reason>".

## 2. Morning bundle (extend `plugins/briefing`)
- Adds: GitHub (via `runtime.callTool('github_notifications')` — read-only), "where you left off" for up to 2 active projects (from §5, cached summary from the night before so the briefing stays fast), Drive backup problems if any.
- Delivery: spoken as today **and** `runtime.notify({ kind: 'briefing' })` (fixed text "Your briefing is ready"; tapping opens Novi which speaks it via the missed queue).

## 3. Sheets logging (new `plugins/sheets-log`)
- One spreadsheet "Novi log" created on first use (id in `data/sheets-log.json`), tabs: `GitHub`, `Study`, `Novi`.
- **GitHub** (nightly 23:50): date, repo, commits that day by the user (GitHub API `/search/commits?q=author:<login>+committer-date:<date>` via the github plugin's signed-in account). Read-only on GitHub.
- **Study** (by voice): tool `study_log({ topic, hours | minutes, date? })` → row `date, topic, hours`. "log 2 hours of DSA", "I studied OS for 45 minutes". Approval: none (appends to Novi's own sheet); grantable category not needed.
- **Novi** (nightly 23:55): date, questions asked, coding tasks done/failed, reminders fired, approvals asked — counted from the day's conversation log and task history. No text, only counts.
- Tool `sheets_log_link` → the sheet URL (shown on screen, not read aloud).

## 4. Rules by voice (extend `plugins/reminders`)
- `repeat` grows from `daily | weekdays` to also `weekly:<mon..sun>` (one or more days) and `hourly:<n>` (n ≥ 1, during 08:00–22:00 only).
- New optional `action` on a reminder: `{ tool, params }` for **read-only** tools only (weather, calendar, briefing, github notifications, sheets link); at the time, Novi runs it through `runtime.callTool` (which already refuses anything needing approval) and speaks/notifies the result. "every morning at 8 tell me the weather" → `{ repeat: 'daily', action: { tool: 'weather_get' } }`.
- `reminder_list` shows rules with their repeat; `reminder_cancel` removes them; Settings → Reminders lists them with delete.

## 5. Project memory (new `plugins/projects`)
- **Sources per remembered project** (memory already knows project paths): last 15 commits (`git log --since=14.days --pretty`), `CLAUDE.md` / `AGENTS.md` / `README.md` "state"/"next"/"TODO" sections (first 4 KB), newest file in `docs/superpowers/plans/` (unchecked `- [ ]` items, max 20), `TODO`/`FIXME` lines in tracked files (max 20, via `git grep`), Novi's last 3 coding tasks on that project. All `execFile`, no shell, read-only.
- **Summary**: one AI call on the **private provider (Groq) only**, `details.sensitive = true`: "Last time: … Still open: … (max 3)". Cached in `data/projects/<name>.json` with the git HEAD it was made at; reused until HEAD or the sources change.
- **Tools**: `project_next({ project? })` — "what's next on NOVI?", "where did I leave off?" (defaults to the last project used).
- **Opening a project**: a service checks the foreground window title every 30 s (existing `win.ps1 window`, no screenshot); if it matches a remembered project name in VS Code / Cursor / Antigravity / Kiro (or `open_project` was just used), Novi says once per project per day: "Last time on NOVI you …" (spoken on the laptop, `sendTo('local')`).
- Morning bundle uses the cached summaries of the 2 most recently active projects.

## Privacy & safety
- Backup zips and logs go only to the user's own Drive/Sheet; nothing private in notifications (fixed texts).
- Only `drive.file` scope: Novi can't read or delete the user's other Drive files.
- Rules can only run read-only tools; anything that sends/changes/deletes still asks.
- Project summaries: Groq only; if Groq is down, the answer lists the raw open items without AI.

## Testing (Vitest, TDD)
`everyDayAt` (runs at time, catches up once after sleep, not twice); Drive upload builds the right multipart request, prunes only Novi's `novi-data-*.zip` in its folder, keeps 7; sheets: creates once, appends rows with right values, study_log parses hours/minutes; Novi stats counts only (no text); reminders `weekly`/`hourly` next-time math and `action` refusing approval-needing tools; projects: source gathering on a temp git repo, cache reuse by HEAD, Groq-only, one-per-day open notice, window-title matching.

## Build order
1. `server/daily.js` + scope + Drive backup. 2. Rules by voice. 3. Sheets logging. 4. Project memory. 5. Morning bundle upgrade. Live checks after the user enables Drive/Sheets APIs and reconnects Google.
