# Laptop Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Volume, brightness, media, battery, Wi-Fi/Bluetooth, power, window and clipboard control by voice, mostly without the AI.

**Architecture:** A new plugin `plugins/laptop-control` talks to one long-lived PowerShell worker (`control.ps1`, JSON lines over stdin/stdout). `server/brain/controlCommand.js` turns common phrases into tool calls that the agent runs directly; the AI gets the same tools. Approvals come from the plugin's `before_tool_call` hook; the hook now also receives who asked (`from`) so phone requests get a warning.

**Tech Stack:** Node ESM, Vitest, Windows PowerShell 5.1 + inline C# (Add-Type), WinRT `Windows.Devices.Radios`, WMI.

**Spec:** `docs/superpowers/specs/2026-10-15-novi-laptop-control-design.md`

## Global Constraints

- No admin rights, no new npm dependencies, no extra installs.
- Not Windows → every tool answers "Laptop controls work only on Windows."
- Asks first (spoken yes): shut down, restart, sleep, sign out, lock, Wi-Fi off, Bluetooth off, closing any window. Approvals: `severity: 'warning'`, `category: 'laptop'`, `grantable: false`.
- From a phone, Wi-Fi off / Bluetooth off / sleep / shut down / restart add: "You'll lose the connection to Novi until the laptop is back."
- Clipboard text that `looksSecret` (`plugins/wiki/vault.js`) is never spoken or shown: "That looks like a password, I won't read it out."
- Paste never presses Enter: "Pasted into X. I didn't send it."
- Shut down / restart: `shutdown.exe /t 15`; reply "Shutting down in 15 seconds. Say cancel to stop." (restart: "Restarting in 15 seconds. Say cancel to stop.")
- Volume/brightness steps: 10. Every failure is an honest error, never "Done.".

## Review Focus

- "pause" / "play" while a coding task or approval is active → today those words don't mean anything special, so media keys are fine; "stop"/"cancel" keep their old meaning unless a power countdown runs (Task 6 test).
- A spoken app name matching Novi's own page ("close Novi", "switch to Chrome" when only Novi's Chrome tab is open) → Novi's window is never closed or chosen as the work window (Task 3 test).
- "close all Chrome windows" with 0 windows → "I don't see a window for Chrome." and no approval asked (Task 4 test).
- Worker hangs on a WinRT call → the command fails after 10 s with "I couldn't reach the laptop controls." and the next command still works (Task 2 test).
- "copy your answer" with no previous reply → "There's nothing to copy yet." (Task 6 test).

---

### Task 1: who asked reaches `before_tool_call`

**Files:**
- Modify: `server/plugins/host.js` (`gate(tool, params, { toolCallId, from })` passes `from` in the hook event), `server/brain/agent.js` (`handle` keeps `this._from = from`; `_runToolInner` calls `tool.gate(args, { toolCallId: call.id, from: this._from })`)
- Test: `tests/server/plugins.test.js`, `tests/server/agent.test.js`

**Interfaces:**
- Produces: `before_tool_call` event `{ toolName, params, toolCallId, from }`, `from` = `'local'` or `{ deviceId }` (default `'local'`).

- [ ] Step 1: tests — `host.gate(tool, {}, { from: { deviceId: 'p1' } })` gives the handler `event.from` = `{ deviceId: 'p1' }`, and `'local'` when omitted; `agent.handle('x', { from: { deviceId: 'p1' } })` with a model calling a plugin tool → its hook sees `{ deviceId: 'p1' }`.
- [ ] Step 2: run `npx vitest run tests/server/plugins.test.js tests/server/agent.test.js` → FAIL (from undefined).
- [ ] Step 3: implement. Step 4: run → PASS.
- [ ] Step 5: commit `Plugin host: before_tool_call knows who asked`.

### Task 2: the control worker

**Files:**
- Create: `plugins/laptop-control/worker.js`, `plugins/laptop-control/control.ps1`
- Test: `tests/server/laptopControlWorker.test.js`

**Interfaces:**
- Produces: `createControlWorker({ spawnImpl = child_process.spawn, script, platform = process.platform, timeoutMs = 10_000, logger }) → { run(cmd: string, args?: object): Promise<object>, stop(): void }`. Protocol: write `{"id":n,"cmd":..,"args":{..}}\n`; read lines `{"id":n,"ok":true,...}` / `{"id":n,"ok":false,"error":"code or text"}`. `run` resolves the result object (without id/ok) or rejects `Error(error)`. Not win32 → rejects `Error('not-windows')`. Timeout → rejects `Error('timeout')` and kills the child (next `run` spawns a new one). Child exit → pending runs reject `Error('worker-exit')`; next `run` respawns.
- `control.ps1` commands (spec §A): `volume {level?, delta?, mute?}` → `{level, muted}`; `brightness {level?, delta?}` → `{level}` | error `no-brightness`; `media {key}`; `battery` → `{percent, charging, minutesLeft?}` | `{none:true}`; `radio {kind, on?}` → `{on}` | error `no-radio`; `lock`; `sleep`; `power {action: shutdown|restart|signout}`; `power-cancel`; `windows` → `{windows:[{id, title, process}]}` (z-order, visible, titled, top-level); `window {id, do}`; `clip-get` → `{text}`; `clip-set {text}`; `keys {combo: copy|paste}`.

- [ ] Step 1: tests with a fake child (EventEmitter stdout/stderr + `stdin.write` capture): run sends one JSON line and resolves the matching id's result; two concurrent runs resolve by id; `ok:false` rejects with its error; non-win32 rejects `not-windows` without spawning; a run with no answer rejects `timeout` after `timeoutMs` (fake timers) and the next run spawns a second child; child `exit` rejects pending runs and respawns on next run; spawn args are `['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', script]` with `windowsHide: true`.
- [ ] Step 2: run `npx vitest run tests/server/laptopControlWorker.test.js` → FAIL (module missing).
- [ ] Step 3: implement `worker.js`; write `control.ps1` (read-line loop, `ConvertFrom-Json`, one `switch` per command, every command in try/catch → `ok:false`). Core Audio: the standard `IMMDeviceEnumerator`/`IAudioEndpointVolume` C# interop; windows: `EnumWindows` + `GetWindow(GW_HWNDNEXT)` order, `ShowWindow` 6/3/9, `PostMessage WM_CLOSE`, focus via `SetForegroundWindow` after a synthetic Alt key; media keys via `keybd_event` 0xB3/0xB0/0xB1; radios via `[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]` `GetRadiosAsync` + `SetStateAsync` awaited with `AsTask`.
- [ ] Step 4: run → PASS.
- [ ] Step 5: commit `Laptop control: PowerShell worker`.

### Task 3: window names

**Files:**
- Create: `plugins/laptop-control/windows.js`
- Test: `tests/server/laptopWindows.test.js`

**Interfaces:**
- Produces: `findWindows(list: {id,title,process}[], name: string) → same[]` (front-most first, Novi's page never included); `workWindow(list) → window|null` (front-most non-Novi); `isNovi(w) → boolean` (title contains "Novi" and process is chrome|msedge|firefox|brave|opera); `appLabel(w) → string` (alias display name, e.g. "Chrome").

- [ ] Step 1: tests — list `[Novi (chrome, front), WhatsApp (WhatsApp), "Inbox - Gmail - Google Chrome" (chrome), "main.js - NOVI - Visual Studio Code" (Code), "ドキュメント" (explorer)]`: `findWindows(l,'chrome')` → only the Gmail window; `'google chrome'` same; `'vs code'`/`'vscode'`/`'code'` → Code window; `'whatsap'` (typo) → WhatsApp; `'file explorer'` → explorer; `'novi'` → `[]`; `'zoom'` → `[]`; `workWindow(l)` → WhatsApp; with Novi not in front, `workWindow` → the front window.
- [ ] Step 2: run → FAIL. Step 3: implement (aliases → process names; then whole-word match on title/process, case-insensitive; then edit distance ≤ 1 for names ≥ 5 letters, own small helper — no import from `plugins/files`). Step 4: run → PASS.
- [ ] Step 5: commit `Laptop control: window names`.

### Task 4: the plugin tools and approvals

**Files:**
- Create: `plugins/laptop-control/index.js`, `plugins/laptop-control/openclaw.plugin.json`
- Test: `tests/server/laptopControlPlugin.test.js`

**Interfaces:**
- Consumes: Task 1 event `from`; Task 2 `worker.run`; Task 3 `findWindows`, `workWindow`, `appLabel`; `looksSecret` from `plugins/wiki/vault.js`.
- Produces: `createLaptopControlPlugin({ worker, platform = process.platform, sleep })`, default export uses a real worker. Tools and params:
  - `laptop_volume {level?: 0-100, change?: 'up'|'down', mute?: boolean}` → `{level, muted, note}` ("Volume 30." / "Muted." / "Unmuted.")
  - `laptop_brightness {level?, change?}` → `{level, note}` ("Brightness 70.")
  - `laptop_media {key: 'play'|'pause'|'next'|'previous'}` (play and pause both send play/pause) → note "Paused." / "Playing." / "Next." / "Previous."
  - `laptop_battery {}` → `{percent, charging, minutesLeft, note}` ("72%, charging." / "72%, about 1 h 40 min left.")
  - `laptop_radio {kind: 'wifi'|'bluetooth', on: boolean}` → note "Wi-Fi is off." etc.
  - `laptop_power {action: 'lock'|'sleep'|'shutdown'|'restart'|'signout'|'cancel'}` → shutdown/restart also `{countdownUntil: ms}`
  - `laptop_window {app, do: 'focus'|'minimize'|'maximize'|'close', all?: boolean}` → note "Switched to WhatsApp." / "Closed 3 Chrome windows."
  - `laptop_clipboard {do: 'read'|'copy'|'set'|'paste', text?, app?}` → read: `{text, note}`, `sensitive: true`; paste note "Pasted into WhatsApp. I didn't send it."
  - Approval titles: "Shut down the laptop?", "Restart the laptop?", "Put the laptop to sleep?", "Sign out?", "Lock the laptop?", "Turn Wi-Fi off?", "Turn Bluetooth off?", "Close Chrome?", "Close all 3 Chrome windows?"; phone suffix per Global Constraints for wifi/bluetooth off, sleep, shutdown, restart.

- [ ] Step 1: tests with a fake worker recording `run` calls and returning canned results:
  - volume `{change:'up'}` → `run('volume',{delta:10})`; `{level:30}` → note "Volume 30."
  - battery none → "This laptop doesn't report a battery."
  - brightness error `no-brightness` → error "I can't change this screen's brightness."
  - radio off approval title "Turn Wi-Fi off?"; with `from:{deviceId:'p'}` the title ends with "You'll lose the connection to Novi until the laptop is back."; radio on → no approval; approval has `grantable: false`.
  - lock asks "Lock the laptop?" (no phone suffix); shutdown from phone has suffix; cancel needs no approval; shutdown result has `countdownUntil` ≈ now+15000 and note "Shutting down in 15 seconds. Say cancel to stop."
  - window close one → asks "Close Chrome?"; all with 3 matches → "Close all 3 Chrome windows?" and `run('window',{do:'close'})` 3 times; no match → error "I don't see a window for Zoom." and the gate asks nothing; focus picks the front-most match.
  - clipboard read secret (`"password: hunter2"`) → error-free reply with note "That looks like a password, I won't read it out." and no `text`; read normal → `sensitive: true`; copy → `run('window',{id: work.id, do:'focus'})`, `run('keys',{combo:'copy'})`, then `clip-get`, note "Copied: …"; paste into WhatsApp → focus WhatsApp + keys paste, never any `keys` other than copy/paste, note "Pasted into WhatsApp. I didn't send it."
  - non-Windows platform → every tool returns error "Laptop controls work only on Windows."; worker `timeout` → error "I couldn't reach the laptop controls."
- [ ] Step 2: run `npx vitest run tests/server/laptopControlPlugin.test.js` → FAIL.
- [ ] Step 3: implement; manifest lists the 8 tools.
- [ ] Step 4: run → PASS. Step 5: commit `Laptop control: tools and approvals`.

### Task 5: phrases without the AI

**Files:**
- Create: `server/brain/controlCommand.js`
- Test: `tests/server/controlCommand.test.js`

**Interfaces:**
- Produces: `controlCommand(text: string) → { tool, args } | { tool: 'laptop_clipboard', args: { do: 'set' }, lastReply: true } | null`; `isCancelWord(text) → boolean` ("cancel", "stop", "ruko", "cancel the shutdown/restart", "rok do", "mat karo").

- [ ] Step 1: tests (spec §D), each → exact `{tool,args}`:
  - "volume 40" / "set the volume to 40 percent" → volume `{level:40}`; "volume up" / "louder" / "awaaz badhao" → `{change:'up'}`; "awaaz kam karo" / "quieter" → down; "mute" → `{mute:true}`; "unmute" → `{mute:false}`
  - "brightness 70" → `{level:70}`; "brightness kam karo" → down
  - "pause" → media pause; "play" / "resume" → play; "next song" / "agla gaana" → next; "previous song" → previous
  - "how much battery" / "battery kitni hai" → battery
  - "turn wifi off" / "wifi band karo" → radio `{kind:'wifi', on:false}`; "turn bluetooth on" / "bluetooth chalu karo" → on
  - "lock the laptop" → power lock; "put the laptop to sleep" → sleep; "shut down" → shutdown; "restart the laptop" → restart; "log out" → signout; "cancel the shutdown" → cancel
  - "switch to WhatsApp" / "go to whatsapp" → window `{app:'WhatsApp', do:'focus'}`; "minimize chrome" → minimize; "close chrome" → close; "close all chrome windows" → close `all:true`; "chrome band karo" → close
  - "read what I copied" / "kya copy kiya" → clipboard read; "copy this" → copy; "copy your answer" → `lastReply: true`; "copy hello world" → set `{text:'hello world'}`; "paste it into whatsapp" → paste `{app:'WhatsApp'}`
  - null: "play despacito on youtube", "play despacito", "open youtube", "switch to novi", "close it", "stop", "search the web for volume"
  - `isCancelWord`: true for "cancel", "ruko", "stop the shutdown"; false for "cancel my meeting"
- [ ] Step 2: run → FAIL. Step 3: implement (strip `FILE_LEAD`/`FILE_TAIL` copies: export them from `agent.js`? No — move both regexes to `server/brain/phrases.js` and import in both files). Step 4: run → PASS.
- [ ] Step 5: commit `Laptop control: phrases without the AI`.

### Task 6: agent wiring

**Files:**
- Modify: `server/brain/agent.js` (route after `fileCommand` in `handle` and `firstStep`; `lastReply` fill; countdown cancel before `quickCommand`), `server/brain/toolSelect.js` (group `laptop` words)
- Test: `tests/server/agent.test.js`, `tests/server/toolSelect.test.js`

**Interfaces:**
- Consumes: Task 5 `controlCommand`, `isCancelWord`; Task 4 result `countdownUntil`.
- Produces: `Agent._countdown = { until, tool, args }` set in `_runTool` when an output has `countdownUntil`.

- [ ] Step 1: tests:
  - "volume 30" runs `laptop_volume {level:30}` directly, router never called, reply = note.
  - "copy your answer" after a reply "The answer is 42." runs clipboard set `{text:'The answer is 42.'}`; with no history → "There's nothing to copy yet."
  - after "shut down" (approved) returns `countdownUntil` in the future, "cancel" runs `laptop_power {action:'cancel'}` (not the task stop); after it expires, "cancel" behaves as before.
  - toolSelect: "turn up the volume", "close chrome", "battery kitni hai", "paste it into whatsapp", "lock my laptop" bring `laptop_volume`…`laptop_clipboard`; "what's the weather" doesn't.
- [ ] Step 2: run → FAIL. Step 3: implement; toolSelect `laptop` words: `volume louder quieter mute unmute awaaz sound brightness bright dim media pause resume next previous song gaana battery charge charging wifi wi-fi bluetooth lock sleep shutdown shut restart reboot signout logout window windows switch minimize maximize close clipboard copy copied paste band chalu`. Step 4: run → PASS.
- [ ] Step 5: commit `Laptop control: by voice`.

### Task 7: wrap-up

- [ ] Full suite `TZ=Asia/Kolkata npx vitest run` → only the 2 known env failures.
- [ ] `tools/my-commands.json`: "volume 30", "battery kitni hai", "switch to WhatsApp", "close chrome", "read what I copied".
- [ ] Live checklist for the laptop in the PR body (every command once, phone shut down warning, cancel within 15 s).
- [ ] CLAUDE.md note; push; draft PR; subscribe.
