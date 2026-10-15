# Laptop control (system, windows, clipboard) — design

Date: 2026-10-15 · Status: design approved in chat, spec awaiting review · Part A of "JARVIS laptop
access" (B = PowerShell fallback with safety levels, C = browser agent — separate specs).

## Goal

Everyday laptop control by voice, fast and without the AI for common phrases:

1. System: volume, mute, brightness, media play/pause/next/previous, battery, Wi-Fi and Bluetooth
   on/off, lock, sleep, shut down, restart, sign out.
2. Windows: switch to, minimize, maximize, close one app's window, close all windows of an app.
3. Clipboard: read what I copied, copy this (selection), copy your answer / copy "<words>", paste it
   into <app>.

User's choices (2026-10-15):
- **Asks first: anything that turns something off** — shut down, restart, sleep, sign out, lock,
  Wi-Fi off, Bluetooth off, closing any window (one or all). Everything else runs at once.
- **From the phone: ask + warn** — Wi-Fi off, Bluetooth off, sleep, shut down, restart add "You'll
  lose the connection to Novi until the laptop is back."
- **Clipboard: read, but not secrets** — text that `looksSecret` (password/OTP/PIN/card/API key)
  is never spoken or shown: "That looks like a password, I won't read it out."

Success = on the laptop and the phone: "volume 30", "pause", "battery kitni hai", "switch to
WhatsApp", "close Chrome" (asks), "read what I copied", "copy this" then "paste it into WhatsApp"
(text appears, nothing sent), "shut down" (asks, 15 s countdown, "cancel" stops it).

## Out of scope

Any other command (Part B), browser automation (Part C), external-monitor brightness (DDC/CI),
choosing audio devices, per-app volume, pressing Enter/Send after a paste.

## Parts

### A. Control worker (`plugins/laptop-control/control.ps1` + `worker.js`)

- One PowerShell process started on first use and kept alive (like `server/voice/localSpeaker.js`):
  reads one JSON line per command on stdin, answers one JSON line `{ ok, ...result }` or
  `{ ok: false, error }`. C# helpers are compiled once at start (Add-Type). Restarted on exit;
  each command times out after 10 s. Windows only — elsewhere every tool says "Laptop controls
  work only on Windows."
- No admin rights, no extra installs. Commands:
  - `volume {level?|delta?|mute?}` → Core Audio `IAudioEndpointVolume` (exact %, mute) → `{ level, muted }`
  - `brightness {level?|delta?}` → WMI `WmiMonitorBrightnessMethods` (laptop panel) → `{ level }`;
    none → error "no-brightness"
  - `media {key: play|next|previous}` → media virtual keys (play = play/pause toggle)
  - `battery` → `Win32_Battery` → `{ percent, charging, minutesLeft? }`; none → `{ none: true }`
  - `radio {kind: wifi|bluetooth, on}` → WinRT `Windows.Devices.Radios` (same as Action Center) →
    `{ on }`; not found / denied → error "no-radio"
  - `lock` (LockWorkStation), `sleep` (SetSuspendState), `power {action: shutdown|restart|signout}`
    (`shutdown.exe /s|/r /t 15`, `/l`), `power-cancel` (`shutdown.exe /a`)
  - `windows` → visible top-level windows in z-order `[{ id, title, process }]` (Novi's own page
    marked `novi: true` = window title contains "Novi" and a browser process)
  - `window {id, do: focus|minimize|maximize|restore|close}` (close = WM_CLOSE, so apps ask to save)
  - `clip-get` → `{ text }`, `clip-set {text}`, `keys {combo: copy|paste}` → Ctrl+C / Ctrl+V to the
    front window

### B. Window names (`plugins/laptop-control/windows.js`)

`findWindows(list, name)` matches a spoken app name against process and title: aliases
(chrome → chrome / "Google Chrome", edge → msedge, vs code / vscode → Code, whatsapp → WhatsApp,
file explorer → explorer, word → WINWORD, excel → EXCEL, spotify, notepad…), then whole-word
title/process match, then the fuzzy matcher from the files plugin (edit distance) for STT slips.
Returns all matches, front-most first. `workWindow(list)` = the front-most window that is not
Novi's page (what "this" / "it" / "here" means).

### C. Tools (plugin `laptop-control`)

`laptop_volume`, `laptop_brightness`, `laptop_media`, `laptop_battery`, `laptop_radio`,
`laptop_power` (lock/sleep/shutdown/restart/signout/cancel), `laptop_window`
(app, do: focus|minimize|maximize|close, all?), `laptop_clipboard` (do: read|copy|set|paste,
text?, app?). Replies are one short sentence ("Volume 30.", "72%, charging.", "Switched to
WhatsApp.", "Pasted into WhatsApp. I didn't send it."). Results are not private except clipboard
reads (`sensitive: true`).

Approvals (`before_tool_call` → `requireApproval`, `severity: 'warning'`, category `laptop`):
`laptop_power` (all but cancel), `laptop_radio` with `on: false`, `laptop_window` with
`do: 'close'`. Title = the short spoken question ("Shut down the laptop?", "Turn Wi-Fi off?",
"Close Chrome?", "Close all 3 Chrome windows?"). When the request comes from a phone
(`from.deviceId`) and the action is Wi-Fi off / Bluetooth off / sleep / shut down / restart, the
question adds "You'll lose the connection to Novi until the laptop is back." These approvals are
never skipped by the direct-command rule (`ASK_ANYWAY`) and are not grantable "always".

Shut down / restart: Windows waits 15 s; Novi says "Shutting down in 15 seconds. Say cancel to
stop." and "cancel" / "ruko" within that time runs `power-cancel` ("Okay, cancelled.").

### D. Voice without the AI (`server/brain/controlCommand.js`)

`controlCommand(text)` → `{ tool, args }` or null, wired in the agent next to `fileCommand`
(uses the same `FILE_LEAD`/`FILE_TAIL` stripping). Phrases (English + Hinglish):
- volume: "volume 40", "set (the) volume to 40 (percent)", "volume up/down", "louder/quieter",
  "awaaz badhao/kam karo/tez/dheere", "mute", "unmute"
- brightness: "brightness 70", "brightness up/down", "brightness badhao/kam karo"
- media: "pause", "play", "resume", "next (song)", "previous (song)", "gaana roko/agla gaana"
- battery: "how much battery", "battery (level/status)", "battery kitni hai/kitna hai"
- radio: "turn wi-fi/wifi/bluetooth on|off", "wifi band karo/chalu karo"
- power: "lock (the laptop/screen)", "sleep", "put the laptop to sleep", "shut down (the laptop)",
  "restart (the laptop)", "sign out / log out", "cancel (the) shutdown"
- windows: "switch to X", "go to X", "open X window", "minimize X", "maximize X", "close X",
  "close all X (windows)", "X band karo" — X never one of: Novi, it (unless a window was just named)
- clipboard: "read what I copied", "what's on my clipboard", "kya copy kiya", "copy this/that/the
  selection", "copy your answer/reply/that answer", "copy <words>", "paste (it) (in|into) X"
Up/down steps: 10 for volume and brightness. "Pause"/"play" alone are media keys ("play X" with
more words stays YouTube). While a shut down / restart countdown runs (15 s), "cancel" / "stop" /
"ruko" cancel it before any other meaning of those words (today they stop the coding task).

### E. Clipboard rules

- read: text only (images/files → "There's no text on the clipboard."); `looksSecret` → refuse;
  else speak the first 2 sentences, show up to 2,000 characters.
- copy this: Ctrl+C on `workWindow` (focus it first), 150 ms, read back, answer "Copied: <first 8
  words>…" (secret → "Copied." only).
- copy your answer: Novi's last reply (the agent passes it as `text` with `do: 'set'`).
- paste into X: focus X (asks nothing, it's not "off"), Ctrl+V, answer "Pasted into X. I didn't
  send it." Never presses Enter.

## Errors

Not Windows → "Laptop controls work only on Windows." · worker crash → restart once, then "I
couldn't reach the laptop controls." · no window match → "I don't see a window for X." · several
matches for focus/minimize/maximize → the front-most one · no brightness / no radio → plain
sentence pointing to the Action Center · every failure is an honest error (never "Done.").

## Testing (TDD, Vitest)

`controlCommand` phrases (en + Hinglish, negatives: "open YouTube", "pause the coding task" stays
as is, "play X on YouTube" stays YouTube) · `findWindows` aliases/fuzzy/front-most, `workWindow`
skips Novi · tools with a fake worker: replies, approval titles, phone warning, `sensitive`
clipboard, secret refusal, paste never sends Enter, close-all count · worker protocol (JSON lines,
timeout, restart) with a fake child process. `control.ps1` is checked live on the laptop with a
short checklist (Windows-only APIs can't run in the cloud container).
