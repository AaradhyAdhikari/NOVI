# Dictation + desktop orb

Date: 2026-10-18 · Status: approved in chat ("YES"). User's choices: dictation by voice **and** hotkey; orb
always on screen, small in a corner; dictation + orb before the Android app; old clipboard put back.

## Orb (`plugins/orb`)
- `orb.ps1`: PowerShell + WPF window (nothing to install), 56 px, always on top, never takes the focus
  (WS_EX_NOACTIVATE + tool window), bottom-right by default, draggable (place saved in data/orb.json).
- Looks: idle (dim cyan), listening (cyan pulse), thinking (purple, spinning ring), speaking (green
  pulse), quiet (dim grey). States come from `runtime.laptopState` (`server/laptopState.js`, fed by the
  messages Novi sends to the laptop and by the laptop speakers).
- Left click = tap → `runtime.wake.listen()` (like "Hey Novi"); drag = move. Right click: Open Novi,
  Hide for 1 hour, Hide until Novi restarts. `NOVI_ORB=off` turns it off; Windows only.
- JSON lines: events on stdout, `{ state }` on stdin (`orbProcess.js`; restarts after a crash 2/5/15/60 s).

## Dictation (`plugins/dictation`)
- Hotkey: hold **Ctrl+Shift+Space** (watched by the orb with GetAsyncKeyState; the keys still reach the
  app) → `runtime.wake.hold()` (the laptop mic's new hold mode, ≤ 60 s) → let go → `release()` WAV
  (null under 0.3 s) → `runtime.hear` (STT + word fixes) → `dictate_type`.
- Voice: "type: …", "type this …", "likho …", "… likh do" (`server/brain/dictationCommand.js`,
  "… in notepad" names the app; "type a message to X" and notes excluded) → `dictate_type`, no AI.
- `dictate_type` → `laptop_clipboard { do: 'type' }`: old clipboard saved, words set, the work window
  (front-most non-Novi) focused, Ctrl+V, old clipboard put back. Never Enter; never asks.
- Needs the laptop wake-word service (the mic) for the hotkey.
