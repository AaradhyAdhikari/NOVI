# Novi Remote Access — Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline, per CLAUDE.md). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Novi installs as a phone app and reaches a paired phone with notifications when Novi isn't open there; opening the app plays the spoken updates it missed.

**Architecture:** `server/push.js` (web-push, VAPID keys in `data/push/`, subscriptions per device, payload whitelist) + `server/missed.js` (per-device queue of spoken lines while that phone has no open socket). `app.js` routes: speech for a device with no socket → missed queue + push. PWA = `public/manifest.webmanifest`, `public/sw.js` (push + notificationclick only), icons. Settings → "Enable notifications".

**Tech Stack:** `web-push` (MIT), Vite `public/`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-novi-remote-access-design.md` (§2 Installable app, §4 Push)

## Global Constraints
- Payload keys only `title`, `body`, `tag`, `url`; body ≤ 120 chars; never text from a `sensitive` result, email text, file names or code. Generic bodies: "Task finished", "Task failed", "Novi needs your OK", "Reminder", "Your briefing is ready", "Wrong PIN 3 times".
- Push only to a paired device with no open WebSocket. 404/410 → delete subscription. Revoking a device deletes its subscriptions and queue.
- Service worker: no page caching.
- Missed queue: last 20 lines per device, in memory; played and cleared on that device's next connect.
- Subscribe only from a paired phone (local laptop doesn't need push).

## Review Focus
- A reminder text (private) must not appear in the push body → generic "Reminder". Test in Task 1.
- Phone reconnects → gets missed lines once, not twice. Test in Task 2.
- Device with socket open on another tab still counts as "open" → no push. Test in Task 2.
- Subscription endpoint not https → rejected. Test in Task 1.
- iOS not installed → UI explains "Add to Home Screen" instead of failing silently. Manual check.

---

### Task 1: Push service
**Files:** Create `server/push.js`; test `tests/server/push.test.js`; `npm install web-push`.
**Produces:** `createPush({ dir, lib, logger })` → `{ publicKey, subscribe(deviceId, sub), removeDevice(deviceId), async send(deviceId, { kind, url }) }`; `kind` ∈ `task_done|task_failed|approval|reminder|briefing|pin_locked` → fixed title/body. `lib` = web-push (injectable): `generateVAPIDKeys`, `sendNotification(sub, payload, { vapidDetails })`.
- [ ] Tests: keys generated once and reused; subscribe rejects non-https endpoint / missing keys; send builds whitelisted payload `{title:'Novi', body:'Task finished', tag:'task', url:'/'}`; unknown kind → nothing sent; 410 → subscription removed; removeDevice clears.
- [ ] Run → FAIL; implement; run → PASS; full suite.

### Task 2: Route speech/notifications to absent phones + missed queue
**Files:** Create `server/missed.js`; modify `server/app.js`; tests in `tests/server/app.test.js`, `tests/server/missed.test.js`.
**Produces:** `createMissedQueue({ max = 20 })` → `{ add(deviceId, text), take(deviceId) -> string[], clear(deviceId) }`. Routes `GET /api/push/key`, `POST /api/push/subscribe` (paired phone only). `runtime.notify({ kind })` → push to `active` phone if absent. On connect of a phone: send `{type:'missed', lines}` then clear. `sendTo(from)` for a phone with no socket: speak → missed queue; task done/failed, approval added, PIN lock, reminder (`runtime.say`), briefing → push kind.
- [ ] Tests: absent phone gets push `approval` when an approval is added and it was last active; open phone gets no push; reconnect delivers missed lines once; revoke clears subscriptions + queue.
- [ ] FAIL → implement → PASS; full suite.

### Task 3: PWA + Settings
**Files:** Create `public/manifest.webmanifest`, `public/sw.js`, `public/icon-192.png`, `public/icon-512.png`, `src/lib/push.js`, `src/components/NotificationsSetup.jsx`; modify `index.html` (manifest link, theme-color), `src/lib/useNovi.js` (`missed` → speak lines in order), `SettingsDrawer.jsx`.
- [ ] `npm run build` passes; manifest served at `/manifest.webmanifest`; `/sw.js` served with JS type (app test).
- [ ] README + CLAUDE.md updated.
