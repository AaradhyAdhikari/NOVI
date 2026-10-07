# Screen control — design (2026-10-08)

Goal: Novi can see the laptop screen and click / type / press keys in apps that have no API (Claude desktop, WhatsApp desktop, …). Roadmap item 7 in CLAUDE.md (#6 in the 2026-10-07 order). Free only.

## Pieces (`plugins/screen`)
- **Driver** (`win.ps1`, run with `powershell -File`): `shot <png>` (primary screen, DPI-aware so pixels match clicks), `click <x> <y>`, `type` (text from the `NOVI_SCREEN_TEXT` env var — never on the command line), `key <name>`, `window` (title of the foreground window). Injected in tests.
- **Vision** = `api.runtime.vision(png, prompt)`: Gemini's free vision model on the existing `GEMINI_API_KEYS`. **The user agreed (2026-10-07) that screenshots may go to Gemini.** Groq has no suitable vision model. Results are marked `sensitive`.
- Coordinates: Gemini returns the target's centre as `[y, x]` on a 0–1000 grid (its native pointing format); the plugin converts to pixels using the screenshot size.

## Tools
| Tool | What | Approval |
|---|---|---|
| `screen_look` | screenshot + answer a question about it ("what's on screen?") | none (read-only) |
| `screen_click` | find a described element ("the Send button in WhatsApp") and click it | **yes**, category `screen` (grantable) |
| `screen_type` | type text into whatever has focus | **yes**, `screen` (grantable) |
| `screen_key` | press Enter / Tab / Esc / arrows / Ctrl+C/V/S/A/Z / Alt+Tab … (allow-list) | **yes**, `screen` (grantable) |

## Right app only
- `screen_click`, `screen_type` and `screen_key` must name the `app` they are for, and act only if that app is the active window (otherwise Novi says which window is active and does nothing). Added after a live test where vision "found" a box in a window that wasn't open and the text went into the Claude app instead. `screen_focus` (no approval) brings a named app to the front first. Vision is told not to guess.

## Never
- Act when the foreground window or the target looks like a **password / sign-in / payment / bank / card / CVV / OTP / CAPTCHA / Windows Security / Settings / UAC** screen → blocked with an explanation (and Vision is also asked to flag such targets). No grant overrides this.
- Keys that could be destructive or system-level (Win+R, Alt+F4, Ctrl+Alt+Del, Delete) are not on the allow-list.
- No loops: each tool call is one action the model asks for; every action is visible in the chat feed.

## Not now
- Multi-monitor (primary screen only), drag-and-drop, scrolling by mouse wheel (use PageDown key).
