# Novi Flick: phone to laptop with a flick (design, 2026-11-16)

## Why
The user wants Flik-style sharing (inspiration: the `__diditee__` "Flik" reel) inside Novi: flick a photo, file,
link or video from the phone and it lands on the laptop with a futuristic effect. It is for presentations,
showing things on a big screen, and making Novi look advanced. Voice works too. TV comes later and reuses the stage.

## Goals (v1, one way: phone → laptop)
- Phone: a flick screen in the Novi page (pick photos/files or paste a link, swipe the card up, a buzz).
  Android share menu "Flick to Novi" (Photos, YouTube, Chrome, Files) in the app.
- Laptop: a full-screen "stage" (dark teal glowing grid, like the reel). Each item flies in as a tilted 3D card
  and fans into a stack. Tap a card = open it in its normal app. Links and videos open by themselves after landing
  (a YouTube link keeps its time). Files are saved to `Downloads\Novi Flick\<date>\`.
- Voice: "open the stage / flick mode", "close the stage", "open the last flick".

## Non-goals (later)
Laptop → phone (reverse), TV receiver, mirroring a live window, presentation slideshow mode, transfers between
devices other than the paired phone.

## Anti-goals
- Never a file lands outside `Novi Flick`, never overwrites, never runs a received program (`.exe`, `.bat`, … are
  saved but never opened by a tap).
- Never anyone but a paired phone (or the laptop) can send.
- The stage never steals the screen silently: it opens only when something arrives or when asked; Esc closes it.

## Approaches
1. **Full-screen page in an Edge app window, served by the plugin on 127.0.0.1** (picked by the user). Smooth 3D/CSS,
   same page later on a TV, nothing new to install, no certificate warning (plain http on loopback, own profile).
2. Windows-drawn see-through layer (like the orb): clumsy 3D, Defender has blocked that helper before.
3. Electron app: heavy on a laptop short of memory, one more install.

## How (decided)
- `plugins/flick`: upload route (phones allowed) → `store.js` saves with a safe, unique name; `stage.js` = loopback
  http server (stage page, server-sent events, previews of received pictures only); `index.js` opens Edge
  `--app` full screen with its own profile when an item arrives and no stage is open; tools `flick_stage`,
  `flick_open`.
- Core: host `registerHttpRoute({ upload: true, phone: true })` + app.js `POST /api/plugin-upload/:path` that streams
  the body to a temp file (cap 300 MB) and hands it to the plugin. Name in `x-novi-name`, links as `x-novi-kind: link`.
- Phone page: `FlickSend` sheet (button on phones), upload with progress.
- App (APK): file chooser for the WebView + share target that hands shared items to the flick sheet.

## Left to the builder
Exact animation curves, card sizes, how many cards stay on the stage (≤ 12, oldest fades), idle close (5 min).
