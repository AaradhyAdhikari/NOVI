# Novi remote control (RustDesk-style, with voice) — plan

User's choices (2026-11-08): own feature inside Novi, not RustDesk; for real work (smooth video + keyboard);
unlocked by fingerprint/face on the phone; any number of screens, steered by voice from the phone;
replaces Live screen (the old picture view stays as the backup).

Spike (2026-11-08, passed): an off-screen Edge window (`--window-position=-32000,-32000`,
`--auto-select-desktop-capture-source=Screen 1`, `--use-fake-ui-for-media-stream`, no-throttling flags,
`getDisplayMedia` run over CDP with `userGesture: true`) captured the real 1920×1200 screen at ~26 fps,
no prompt, nothing in front. Headless Edge only sees a fake 800×500 screen. Side effect to fix: the fresh
profile showed Edge's "signed in on this device" pop-up.

## Pieces

1. **Laptop streamer** (`plugins/remote-control/streamer.js`): one off-screen Edge per monitor, its own
   empty profile, no sign-in pop-ups; a local page holds the screen track and an `RTCPeerConnection`.
   Video only: no audio for now. Ends with the session; the whole Edge tree is killed.
2. **Setup over Novi's socket**: offer/answer/ICE pass through the existing WebSocket (`rc_signal`),
   only for the one owner device. Tailscale gives the direct path, so no relay server or STUN/TURN.
   The stream itself is encrypted by WebRTC (DTLS-SRTP).
3. **Input** (`rc_input` over a WebRTC data channel, fallback the socket): tap = click, long-press = right
   click, drag = mouse drag, two fingers = scroll, pinch = zoom the view (phone only), keys incl.
   Ctrl/Alt/Win/Esc/Tab/arrows and shortcuts. Sent to one long-running input helper with SendInput
   (mouse move/down/up, keys) in the existing `win.ps1 serve` worker. No capture code is added there
   (Defender rule).
4. **Phone view** (`src/components/RemoteControl.jsx`, inside the Novi app's WebView): full-screen video,
   keyboard button with a modifier row, screen picker when there are several monitors, a small mic
   button for voice. Replaces the Monitor button; if the stream fails, the old Live screen opens.
5. **Voice on top**: while the view is open, "click Submit", "scroll down", "type hello and send",
   "screen 2" go through the existing screen-step routes (`isScreenStep`, Screen Mode parser) with no AI;
   "switch to screen 2" moves the stream and the input to that monitor.
6. **Unlock with the fingerprint** (Android app update): `BiometricPrompt` on the phone signs a
   one-time challenge from Novi (key made at pairing, kept in the Android Keystore, only usable after
   the fingerprint). Novi checks the signature before it starts the stream. PIN stays as the fallback.
7. **Safety**: one phone at a time; ends after 15 min without a touch or on "stop remote control";
   a banner on the laptop orb while someone is controlling it; never types into a focused password box;
   every session logged (start, end, device, never the keystrokes).

## Order (each with tests first)

1. Streamer + setup + video on the phone page (view only). **Built 2026-11-08** (stand-in phone: 1920x1200 at 24 fps; phone not tried yet).
2. Mouse and keyboard input.
3. Phone view polish (keyboard row, gestures, screen picker) and Live screen fallback.
4. Voice on top.
5. Fingerprint unlock (app update).
6. Several monitors; later other computers running Novi.

## Not in v1
Laptop sound on the phone, file transfer, clipboard sync, other computers.
