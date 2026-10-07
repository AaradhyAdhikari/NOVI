# Production foundation — design (2026-10-07)

Goal: Novi is always there when the laptop is on, recovers by itself, never loses data, and shows what's wrong when something breaks.

## 1. Supervisor (`server/supervisor.js`)
- Runs `node --env-file-if-exists=.env server/index.js` as a child and restarts it when it exits.
- Backoff: 1 s, 2 s, 5 s, 10 s, 30 s; reset after 60 s of healthy running. More than 5 crashes in 2 minutes → wait 5 minutes (avoid burning API quota in a crash loop).
- Exit code **75** = restart requested (Settings → Restart): restart at once, not counted as a crash. Exit code 0 = stop.
- Passes `NOVI_SUPERVISED=1` and `NOVI_RESTARTS=<n>` to the child.
- Writes the child's output to `data/logs/novi-YYYY-MM-DD.log`; keeps 7 days.
- `npm start` / `Start Novi.cmd` build the UI and then run the supervisor.

## 2. Start at Windows login
- `Install Autostart.cmd` (the user double-clicks it) registers a per-user Scheduled Task **"Novi"**: at logon, hidden window, runs the supervisor. No admin rights needed. `Remove Autostart.cmd` deletes it.
- Novi never creates the task by itself (it is persistent system configuration).

## 3. Backups (`plugins/backup`)
- Service: on start and every hour, if the newest backup is older than 24 h, zip `data/` (without `logs/`) to `backups/novi-data-YYYY-MM-DD-HHmm.zip` with Windows' built-in `tar.exe`; keep the newest 14.
- `backups/` sits in the project folder, which OneDrive already syncs → an off-laptop copy for free. Gitignored.
- `data/secrets.json` is DPAPI-encrypted: a restore works on this Windows account only (by design).
- Tools: `backup_now`, `backup_status` (read-only, no approval).

## 4. Health (Settings → System)
- `GET /api/health`: version (git commit), uptime, restarts, supervised yes/no, wake-word mode, AI providers, last backup, the last 50 warnings/errors (captured from `console.warn/error`).
- `POST /api/restart`: only when supervised; exits with 75.
- Settings shows it with **Restart Novi** and **Copy diagnostics** buttons.

## Not now
- One-click update (`git pull`) — the user develops on this laptop, so pulling would fight local changes. Revisit when Novi runs from a release.
