# Laptop commands with safety levels — design

Date: 2026-10-15 · Status: design approved in chat ("start building"), spec awaiting review · Part B of
"JARVIS laptop access" (A = laptop control, done; C = browser agent, next). Covers Dodaios port #7
(safety levels + action history).

## Goal

When no ready-made tool fits ("how much space is left on D:", "which app uses the most memory",
"rename all .jpeg files in Downloads to .jpg"), Novi writes one PowerShell command, sorts it into a
safety level, and runs it or asks first. Every command is kept in a history.

User's choices (2026-10-15):
- **Look-only** commands run at once.
- **Changes**: spoken yes, the exact command on the card; same from the phone.
- **Dangerous**: spoken yes **plus the voice PIN**, on the laptop and the phone.
- **History**: Settings → History (laptop only) and by voice ("what commands did you run today?").

Kept although not asked for: a short **never** list that is always refused (see §B) — a misheard
sentence plus a model mistake must not be able to turn off the antivirus. The user may remove it.

Success = "how much space is left on D:" answers in one go; "rename all .jpeg files in Downloads to
.jpg" asks "Rename the .jpeg files in Downloads to .jpg?" and shows the command; "delete the temp
folder in Downloads" asks for yes and the PIN; "turn off Windows Defender" is refused; "what commands
did you run today?" lists them.

## Out of scope

Running as admin (never elevates; a command needing admin fails and says so), multi-step scripts
(one command line per tool call; the AI may call again), commands on the phone, editing the
history, the Dodaios "activity diary" (separate item #8).

## Parts

### A. Tool `laptop_run` (plugin `plugins/commands`)

`laptop_run { command: string, purpose: string }` — `purpose` = what it does in a few words, written
by the AI ("Check free space on D:"), used as the spoken question and in the history. Description
tells the AI: only when no other tool fits; one command; prefer read-only; never ask the user to
paste commands. Result `{ level, ok, exitCode, output (≤4,000 chars), note }`, `sensitive: true`.
Offered by toolSelect group `commands` (words: command commands powershell terminal cmd run disk
space drive drives storage memory ram cpu process processes running ip network port ports installed
size sizes largest biggest rename extension extensions service services uptime).

### B. Safety levels (`plugins/commands/classify.js`, pure, tested)

`classify(command) → { level: 'look'|'change'|'danger'|'never', reason }`. Conservative: anything
the checker can't prove is look-only is at least a change.

- Split into commands at `;`, `|`, `&&`, `||`, newlines, `{`/`}` script blocks, `$(` `)` and `@(`
  `)` sub-expressions; the command word of each = the first word (aliases resolved: dir/ls/gci =
  Get-ChildItem, cat/gc/type = Get-Content, ps = Get-Process, rm/del/erase/rd/rmdir/ri =
  Remove-Item, mv/move/mi = Move-Item, cp/copy/cpi = Copy-Item, ren/rni = Rename-Item, kill/spps =
  Stop-Process, iex = Invoke-Expression, iwr/curl/wget = Invoke-WebRequest, irm = Invoke-RestMethod,
  % / foreach = ForEach-Object, ? / where = Where-Object, sc = Set-Content, ni = New-Item, …).
- **never** (refused) when any of: `Set-MpPreference` with `-Disable*`, `Add-MpPreference
  -Exclusion*`, `netsh advfirewall … state off`, `Set-NetFirewallProfile … -Enabled False`, download
  piped or passed into `Invoke-Expression`/`iex`/`powershell`, `-EncodedCommand`/`-enc`,
  `FromBase64String` fed to execution, `vssadmin delete`, `wbadmin delete`, `bcdedit`, `format`,
  `Format-Volume`, `Clear-Disk`, `diskpart`, `cipher /w`, `Clear-EventLog`, `wevtutil cl`,
  `Remove-Item` on `C:\Windows`, `C:\Program Files*`, a drive root or `$env:SystemRoot`.
- **danger** when any command is: `Remove-Item` (any path not refused above), `Clear-Content`,
  `Clear-RecycleBin`, registry (`HKLM:`/`HKCU:` paths with Set-/New-/Remove-ItemProperty,
  `reg add|delete|import`), services (`Set-|Stop-|Start-|New-|Remove-Service`, `sc.exe`), firewall
  rules (`New-|Set-|Remove-NetFirewallRule`, `netsh advfirewall`), users/groups (`New-|Remove-|Set-
  LocalUser`, `Add-LocalGroupMember`, `net user|localgroup`), installs (`winget install|uninstall`,
  `choco`, `msiexec`, `Install-Package|Module`, `Uninstall-*`), scheduled tasks (`schtasks`,
  `Register-|Unregister-ScheduledTask`), `Start-Process … -Verb RunAs`, `Set-ExecutionPolicy`,
  `takeown`, `icacls`, `Stop-Computer`, `Restart-Computer`, `Invoke-Expression`/`iex`,
  `Invoke-WebRequest`/`Invoke-RestMethod` with `-OutFile` or a method other than GET.
- **look** when every command word is on the read list and nothing writes: `Get-*` (except
  `Get-Credential`), `Test-Path`, `Test-Connection`, `Test-NetConnection`, `Measure-Object`,
  `Select-Object`, `Where-Object`, `Sort-Object`, `Group-Object`, `Format-Table|List|Wide`,
  `Out-String`, `ConvertTo-Json|Csv`, `Select-String`, `Resolve-Path`, `Split-Path`, `Join-Path`,
  `ForEach-Object` (its block checked too), `Write-Output`, and the programs `ipconfig`, `systeminfo`,
  `whoami`, `hostname`, `tasklist`, `netstat`, `nslookup`, `ping`, `where.exe`, `driverquery`,
  `wmic … get`/`list`; and the line has no `>`/`>>` redirection, no `[Type]::Method(` call except
  `[math]::`, `[datetime]::`, `[Environment]::GetFolderPath(`, no `-Force`, no `.Delete(`/`.MoveTo(`
  method calls, no `Invoke-*`, no `Start-Process`.
- **change**: everything else.

### C. Running (`plugins/commands/runner.js` + `check.ps1`)

- `runCommand({ command, level })` spawns `powershell.exe -NoProfile -NonInteractive
  -ExecutionPolicy Bypass -EncodedCommand <base64 UTF-16LE>` in the user's home folder, hidden,
  never elevated (`Start-Process -Verb RunAs` is danger and needs admin anyway), stdout+stderr
  collected, killed after 60 s, output cut at 4,000 characters.
- **Second check for look commands**: the encoded script first runs `check.ps1`'s logic — PowerShell's
  own parser (`[System.Management.Automation.Language.Parser]::ParseInput`) lists every
  `CommandAst` name and every `InvokeMemberExpressionAst`; if any name is not on the read list (same
  list as §B, shipped as `readList.json`) or a method call is not allowed, the script prints
  `NOVI-NOT-LOOK` and exits 3 without running the command. The tool then treats it as a change
  (asks, then runs without the check). Change/danger commands skip the check.
- Not Windows → "Commands work only on Windows." Exit code ≠ 0 → `ok: false`, note "That didn't
  work: <first line of the error>." Timeout → "That took too long, so I stopped it."

### D. Approvals

`before_tool_call` (plugin `commands`):
- look → nothing.
- change → `requireApproval { title: purpose + '?', description: command, severity: 'warning',
  category: 'commands', grantable: false }`. Spoken: the purpose. Works by voice from the laptop and
  the phone (unchanged trust rules).
- danger → same, plus **`pin: true`** (Novi extension, passed through the host like `kind`):
  `server/remoteTrust.js` `requiredProof` returns `'pin'` for a `pin` approval from **any** device,
  the laptop included. No PIN set → the approval says "Set a voice PIN in Settings first." and is
  refused (never runs without the PIN).
- never → `block: true`, reason "I won't run that: <reason>. Here's the command if you want to run it
  yourself: <command>".
- `ASK_ANYWAY` in the agent includes `laptop_run`, so direct routes never skip these questions;
  look commands have no question to skip.

### E. History (`plugins/commands/history.js`, `data/commands/history.jsonl`)

One JSON line per call, also refused and declined ones: `{ at, from: 'laptop'|'phone', level,
purpose, command, ran: boolean, ok, exitCode, output (first 300 chars) }`; keeps the last 500
(rewritten when over 600). Not in the Novi Memory vault (user's choice: Settings + voice only).
- Tool `commands_history { today?: boolean, limit? }` (read-only, `sensitive: true`).
- `GET /api/commands/history` — laptop only (403 elsewhere) — newest first, 100.
- Settings → History (`src/components/CommandHistory.jsx`, laptop only; phone: "Open this on the
  laptop."): time, level chip, who asked, purpose, command in `<code>`, ✓/✗, output in a collapsible
  `<pre>`.
- Voice without the AI (`historyCommand` in `server/brain/controlCommand.js`): "what commands did
  you run (today)", "show me the command history", "aaj kaun se commands chalaye" → "3 today. Last:
  checked free space on D:, listed big files in Downloads, renamed 12 photos." / "None today."

## Errors

Covered in §C/§D. A history file that can't be written never stops a command (warning in the log).

## Testing (TDD, Vitest)

`classify` on ≥40 commands per level including tricks (`Get-Item x; Remove-Item y`, `gci | % { rm
$_ }`, `iex (iwr u)`, `powershell -enc …`, `$(Remove-Item x)`, `Get-Process > out.txt`, aliases,
`Get-ChildItem -Force`) · plugin with a fake runner: levels → approvals (titles, `pin`, `block`),
look runs without asking, `NOT-LOOK` fallback asks then reruns, output cut, `sensitive` · trust:
`pin` approval needs the PIN from the laptop too; no PIN set → refused · history: append, cap,
today filter, laptop-only route · voice route · runner with a fake spawn (encoded arg, timeout kill,
exit code). `check.ps1`/real PowerShell → live checklist.
