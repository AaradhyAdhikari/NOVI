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


## v2 (2026-11-16, after the first live try)
- **Lag** (stage): v1 animated the floor grid's background-position on a huge masked, tilted layer (a full repaint
  every frame), decoded full-size phone photos on every card, and transitioned shadows/filters on 12 cards. Now only
  transform/opacity animate, the floor's inner tile layer slides and only for 4 s after a landing, photos are shrunk
  once with createImageBitmap (resizeWidth 600), only the front video plays, 6 cards stay on the page, the server keeps 8.
- **Close**: the card layer (position: fixed, later in the page) covered the Close button, so the click never reached
  it; Esc failed when the window started without the keyboard. Close now sits above everything, the stack lets clicks
  through, the page focuses itself, Novi focuses the "Novi Stage" window 2.5 s after opening it, and closing ends the
  stage's Edge by its profile with taskkill /T.
- **Actions** (card buttons, right-click, voice; tool flick_do): open, open in browser (links), copy (a photo as the
  picture, a link as text, other files as a file), show in folder, WhatsApp (stage: one approval card via
  runtime.runAsked; voice: the agent sends it like any spoken WhatsApp command), send to an AI from a fixed list
  (sites.js: ChatGPT, Gemini, Claude, Perplexity, Google; a link goes in ?q= where the site takes it, else it is
  copied and the site opens for Ctrl+V). Programs and macro files are never opened or passed on.
- **Real flick** (user: flick first, "Send to Novi" second, on any screen): createFlickDetector (JS) and FlickDetector
  (Kotlin), same numbers: within 300 ms a jolt ≥ 14 m/s² and a pitch ≥ 240°/s mostly about x, right after 300 ms of
  stillness; 1.5 s apart. In the app the foreground service listens (linear acceleration + gyroscope, screen on only):
  Novi open → the flick screen's top card (window.__noviFlick); else a screenshot from the last 90 s, else the browser's
  link, else a picture of the screen (Accessibility takeScreenshot, Android 11+). Never in bank / UPI / password apps
  or with a password box on screen; 1.5 s to cancel. In a browser the page reads devicemotion.
- **Screenshots**: a MediaStore observer (READ_MEDIA_IMAGES, asked on ⚙) spots a new file in a Screenshots folder and
  shows a small pop-up ("Flick your phone to send it" + Send to Novi) for 6 s. The share entry is now "Send to Novi".
- Later: laptop → phone, the TV, choosing which screen.
