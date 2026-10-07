# Novi remote access ("use Novi from anywhere") — design

Date: 2026-10-07 · Roadmap #1 · Approach: **build now, security first** (agreed with the user after a 16-perspective review; all 16 favoured building now, every one flagged the remote trust rules as the risk).

## Goal

The laptop stays at home, on, plugged in, lid open. The user is out with their phone (Samsung Galaxy S24+ first; iPhone must work too). They:

1. tap/hold the talk button on the phone and speak a request — including coding jobs for Novi Coder in their projects;
2. answer Novi's questions and approvals from the phone, by voice where possible;
3. hear spoken progress ("started", "done, 3 files changed, tests pass", "failed because …");
4. get a phone notification when the Novi app is closed or the phone is locked, tap it, and hear what they missed;
5. say "show me the screen" and see a screenshot of the laptop.

Success: from outside the home network, say "in the Novi project add a dark-mode toggle", approve "use Novi Coder?" by voice, lock the phone, get a notification later, tap it, hear the result.

## Non-goals (deferred)

- Phone-specific layout polish, a designed progress card, "show me the result" previews of built sites/apps (comes with the browser agent, roadmap #5).
- "Hey Novi" on the phone (browsers can't listen in the background) — the phone uses tap/hold-to-talk.
- `tailscale serve` / Funnel (proxied requests look like localhost and would skip pairing).
- Offline use, a native app, Telegram, any paid service.

## Existing pieces this builds on

- HTTPS server with self-signed cert covering every network IP (`server/certs.js`); allowed origins built from those IPs (`server/app.js`).
- Pairing: 6-digit code shown only on the laptop, device tokens (hashed) in `data/devices.json`, revoke in Settings (`server/auth.js`).
- Approval queue with tiers `medium`/`high` (`server/permissions.js`), plugin `requireApproval.severity` `warning`→medium, `critical`→high (`server/plugins/host.js`), grants for medium only (`server/grants.js`).
- Events already broadcast over WebSocket: `speak`, `task`, `feed`, `approval_added/resolved`. Phone plays `speak` via `/api/tts` (Edge voice) with speechSynthesis fallback.
- Push-to-talk with Silero VAD, Whisper STT (`src/lib/vadRecorder.js`, `server/voice/speechEngine.js`).
- Screen screenshots (`plugins/screen`, `win.ps1`).

## Components

### 1. Trusted certificate (`server/certs.js`, `server/tailscale.js`)
- At startup, if `tailscale` is on PATH and logged in: read the machine's MagicDNS name (`tailscale status --json` → `Self.DNSName`), run `tailscale cert --cert-file data/certs/ts.crt --key-file data/certs/ts.key <name>`, and serve with that cert. Re-run weekly (certs last 90 days; `tailscale cert` only renews when needed). Runs via `execFile` (no shell).
- Needs MagicDNS + HTTPS certificates turned on in the Tailscale admin console (one-time user step; documented in README).
- `https://<name>:<port>` is added to allowed origins and shown in the pairing panel.
- Any failure → log once, fall back to the self-signed cert (current behaviour). Nothing breaks without Tailscale.
- Requests from Tailscale IPs (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) are **remote**: pairing required, same as LAN.

### 2. Installable app (PWA)
- `public/manifest.webmanifest` (name Novi, icons, `display: standalone`, start URL `/`) and `public/sw.js`.
- The service worker handles **only** `push` and `notificationclick` — no page caching (Novi is useless without the laptop, and stale cached UI would be confusing).
- iPhone: Web Push works only after "Add to Home Screen" (iOS 16.4+). The app detects iOS-not-installed and shows how to install.

### 3. Remote trust rules (`server/remoteTrust.js`) — the security core
Every approval answer arrives with the answering device: `local` (laptop) or a paired device id.

| Approval | At the laptop | From a paired phone |
|---|---|---|
| `medium` (severity `warning`) | tap / "yes" (grants apply) | tap / "yes" (grants apply) |
| `high` (severity `critical`) | screen tap (unchanged) | **voice PIN + tap** |
| `kind: 'delete'` or `kind: 'payment'` (any tier) | screen tap (unchanged) | **passkey (fingerprint / face) + tap** |

- New optional field on approvals: `kind` (`'delete' | 'payment'`). `requireApproval` accepts `kind`; existing tools that delete (e.g. Gmail trash, file deletes) are tagged. Deletes/payments are never grantable (already true).
- The server enforces the table; the UI only collects proof. An answer from a phone without the required proof is refused (`allow` is ignored, approval stays pending, the phone is told what's missing).
- If the phone has no passkey registered, delete/payment approvals say "needs you at the laptop" and wait — never a weaker fallback.
- Unknown / revoked device → refused.

**Voice PIN** (`data/remote-pin.json`)
- 4–8 digits, set at the laptop only (Settings → Permissions). Stored as scrypt hash + salt; never logged, never in transcript, memory or conversation log.
- Spoken flow: after the user taps "Approve" on a critical card, Novi says "Say your PIN"; the next utterance from that device is captured as the PIN attempt (digits parsed from the transcript, incl. "one two three four"), checked, and dropped — it is not shown as chat and not passed to the brain.
- Setting **PIN input**: `voice` (default) or `voice or typed`. Typed input only appears when the setting allows it.
- 3 wrong attempts → remote critical approvals locked 15 min for all devices + push alert "Wrong PIN 3 times".
- Known limitation (accepted): the spoken PIN passes through the speech-to-text provider (Groq Whisper) as text.

**Passkeys** (`server/passkeys.js`, `@simplewebauthn/server` + `@simplewebauthn/browser`, MIT)
- Register from the phone in Settings → Devices ("Set up fingerprint / face"), only while that phone is paired, only over the `ts.net` origin (WebAuthn needs a domain: RP ID = the MagicDNS name).
- `userVerification: 'required'`, platform authenticator. One challenge per approval, bound to the approval id, 2-minute expiry, single use.
- Credentials stored per device in `data/passkeys.json`; revoking a device deletes its passkeys and push subscriptions.

### 4. Push notifications (`server/push.js`, `web-push`, MIT)
- VAPID keys generated once → `data/push/vapid.json`. Subscriptions stored per paired device → `data/push/subscriptions.json`.
- Phone: Settings → "Enable notifications" (must be a user tap on iOS) → subscribe → `POST /api/push/subscribe`.
- Send rule: push to a device only if it has **no open WebSocket**. Expired subscriptions (404/410) are deleted.
- Triggers: task finished / failed, approval needed, reminder due, briefing ready, wrong-PIN lockout.
- Payload whitelist `{ title, body, tag, url }`; body is generic ("Task finished", "Novi needs your OK", "Reminder"). Never email text, file names, code, or anything from a `sensitive` result. Enforced in `push.js` (tests).
- Missed updates: while a device is away, `speak` lines are queued for it (last 20, in memory). Opening the app (or tapping a notification) plays them in order, then clears.
- `api.runtime.notify({ title, body, tag })` for plugins (goes through the same whitelist).

### 5. Stay awake (`server/laptop/keepAwake.js`)
- While Novi runs, it holds `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` (via the persistent PowerShell process) so Windows never idle-sleeps. Display may still turn off. No timeout (user's choice). Released on clean exit.
- No Windows settings changed. Closing the lid can still sleep the laptop (documented).

### 6. Screenshot on request (`plugins/screen`: new tool `screen_show`)
- Takes a screenshot with the existing driver and sends it as an image chat entry to the asking device. No vision call (not sent to Gemini). Result `details.sensitive = true` (keeps the turn on Groq, never in push). Not stored on disk. No approval (read-only).

### 7. Progress by voice
- "How's it going?" answered from the task manager's current state (existing `task` events). Task finish/fail already speaks; on a remote device with the app closed it becomes a push + queued speech.

## Data flow (remote coding job)

Phone talk → `/api/voice` (paired token) → STT → brain → `code_start_task` approval card (choice Novi Coder / Claude) → answered by voice on phone → Novi Coder runs, edits/commands raise `medium` approvals (grants may auto-allow) → task events → `speak` to open phone, or push + queued speech when closed → tap → app opens, plays queued updates.

## Build order (stop point between each; later items move to the next session if time runs out)

1. Tailscale cert + origins + remote detection.
2. Phone voice end to end over Tailscale (talk, spoken replies, approvals by tap/voice).
3. Remote trust rules: device-aware approvals, voice PIN, passkeys, `kind` tagging.
4. PWA + push + missed-update queue + `runtime.notify`.
5. Keep awake.
6. `screen_show`.

## Testing

Vitest (TDD, each rule failing first):
- remote `high` approval without PIN → refused; with correct PIN → allowed; 3 wrong → lockout + alert.
- remote `delete`/`payment` without passkey proof → refused; with valid assertion for that approval → allowed; replayed/expired challenge → refused.
- local approvals unchanged; revoked device can't approve, its subscriptions/passkeys removed.
- PIN never appears in transcript, logs, memory hooks.
- push payload rejects any field outside the whitelist and sensitive text; push only to devices without a socket; 410 removes subscription.
- Tailscale IP treated as remote; cert fallback when `tailscale` missing (fake `execFile`).
- keepAwake sets/clears state (fake runner).
- `screen_show` returns an image, never calls vision.

Live: S24+ over mobile data (Wi-Fi off) — pair, talk, coding task, approvals (warning, critical with PIN, delete with fingerprint), notification while locked, screenshot. iPhone if one can be borrowed.

## User setup (one time)
Install Tailscale on laptop + phone (same account) · admin console: enable MagicDNS + HTTPS certificates · pair the phone · set the voice PIN at the laptop · on the phone: set up fingerprint/face, enable notifications (iPhone: Add to Home Screen first).
