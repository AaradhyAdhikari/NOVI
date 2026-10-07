# Novi Remote Access — Part 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach Novi from the phone anywhere over Tailscale with a trusted certificate, and make every approval answer device-aware so remote critical actions need a voice PIN and remote deletes/payments need a passkey (fingerprint/face). Also keep the laptop awake.

**Architecture:** A small `server/tailscale.js` gets a real cert at startup (fallback: current self-signed). Every message/request carries `from` (`'local'` or a paired device id). `ApprovalQueue.resolve` asks a `RemoteTrust` policy which proof an allow needs; missing proof → refused, approval stays pending. PIN (`server/remotePin.js`, scrypt) and passkeys (`server/passkeys.js`, SimpleWebAuthn) supply the proof. Push, missed-update queue and `screen_show` are Part 2.

**Tech Stack:** Node ESM, Express, ws, Vitest, React; new deps `@simplewebauthn/server`, `@simplewebauthn/browser` (MIT).

**Spec:** `docs/superpowers/specs/2026-10-07-novi-remote-access-design.md`

## Global Constraints
- No `tailscale serve`/Funnel. Tailscale IPs stay remote (pairing required).
- No shell: `execFile` only. No Windows settings changed.
- PIN: 4–8 digits, set at the laptop only, scrypt hash + salt in `data/remote-pin.json`, never logged / in transcript / in memory / sent to the brain. 3 wrong → remote critical approvals locked 15 min.
- PIN input setting `pinInput`: `'voice'` (default) | `'voice-or-typed'`.
- Passkeys: RP ID = Tailscale MagicDNS name, `userVerification: 'required'`, platform authenticator, challenge bound to approval id, 2-min expiry, single use.
- Delete/payment remotely without a passkey → wait for the laptop; never a weaker fallback.
- Denials are always accepted from any authenticated device.
- The user commits (no `git commit`); at each "Commit" step run the full suite and tell the user to run `Commit and Push.cmd` with the suggested message.

## Review Focus
- Voice "yes" from the phone on a delete-kind approval (memory_forget is `warning`) → must be refused remotely (agent passes `from`). Test in Task 3.
- Revoked device with an already-open WebSocket answering an approval → refused. Test in Task 3.
- Spoken PIN like "one two three four" or "1 2 3 4." → parsed to `1234`. Test in Task 4.
- `tailscale` installed but logged out / HTTPS certs disabled in admin → fallback to self-signed, Novi still starts. Test in Task 1.
- Passkey assertion replayed for a second approval or after 2 min → refused. Test in Task 5.

---

### Task 1: Tailscale certificate + origin

**Files:**
- Create: `server/tailscale.js`
- Modify: `server/index.js` (cert selection, lanUrls, weekly renew via `server.setSecureContext`)
- Test: `tests/server/tailscale.test.js`

**Interfaces:**
- Produces: `findTailscale({ exists }) -> string | null` (PATH `tailscale` or `C:\Program Files\Tailscale\tailscale.exe`); `async tailscaleCert({ run, exe, dir }) -> { name, key, cert } | null` where `run(file, args) -> Promise<{ stdout }>`; `name` = `Self.DNSName` without trailing dot. Files `dir/ts.crt`, `dir/ts.key`.

- [ ] **Step 1: Write failing tests** in `tests/server/tailscale.test.js`:
  - `returns name, key and cert when status and cert succeed` — fake `run`: `status --json` → `{"Self":{"DNSName":"novi-laptop.tail1234.ts.net."},"BackendState":"Running"}`; `cert --cert-file … --key-file … novi-laptop.tail1234.ts.net` writes both files; expect `name === 'novi-laptop.tail1234.ts.net'` and buffers equal file contents; assert `run` was called with exactly those args.
  - `returns null when logged out` — `BackendState: 'NeedsLogin'` → `null`, `cert` never called.
  - `returns null when cert command fails` (HTTPS disabled) → `null`.
  - `returns null when exe missing` (`exe: null`).
- [ ] **Step 2:** `npx vitest run tests/server/tailscale.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement `server/tailscale.js`. Any thrown error → `console.warn` once, return `null`.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Wire `server/index.js`: `const ts = await tailscaleCert({...})`; credentials = `ts ? { key: ts.key, cert: ts.cert } : loadOrCreateCert(...)`; if `ts`, push `https://${ts.name}:${config.port}` to the front of `lanUrls` (before `createNovi`) and print it as `Phone (anywhere):`; `setInterval(…, 7 * 24 * 3600_000).unref()` re-runs `tailscaleCert` and calls `server.setSecureContext`.
- [ ] **Step 6:** Add to `tests/server/app.test.js`: `treats a Tailscale address as remote` — with override `isLocalAddress: () => false`, `GET /api/health` without token → 401. (Task 2 adds the override.)
- [ ] **Step 7:** Full suite `npx vitest run` → all green. Commit message: `Use Tailscale certificate when available`.

### Task 2: Device identity on every request and message

**Files:**
- Modify: `server/app.js` (attach `req.from`; `handleMessage(msg, from)`; WS keeps `from` per socket; `overrides.isLocalAddress`; revoked tokens re-checked per message)
- Modify: `server/brain/agent.js` (`handle(text, { from = 'local' } = {})` passes `from` to `_quick` → `approvals.resolve(..., { from })`)
- Modify: `src/components/TalkButton.jsx` only if it bypasses `user_message` (it sends text over WS today — verify, no change expected)
- Test: `tests/server/app.test.js`, `tests/server/agent.test.js`

**Interfaces:**
- Produces: `from` = `'local'` | `{ deviceId: string }`. `handleMessage(msg, from)`. `agent.handle(text, { from })`. `ApprovalQueue.resolve(id, allow, by, choice, { always, from = 'local', proof })` (signature extended; behaviour unchanged until Task 3).

- [ ] **Step 1: Failing tests:**
  - app: `remote socket answers carry the device id` — pair via `/api/pair` with `isLocalAddress: () => false`, connect, `hello` with token, send `{type:'approval', id, allow:true}` for a pending medium approval; spy `approvals.resolve` gets `{ from: { deviceId } }`.
  - app: `a revoked device's open socket can no longer act` — after `DELETE /api/devices/:id` (done locally), the next message closes the socket with 4001 and does not resolve.
  - agent: `voice approval passes from through` — `handle('yes', { from: { deviceId: 'd1' } })` → resolve called with `from` `{ deviceId: 'd1' }`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `createNovi` uses `overrides.isLocalAddress || isLocalAddress` everywhere it checks locality. The `/api` auth middleware sets `req.from`. The WS stores the token and `pairing.verify(token)` before each message.
- [ ] **Step 4:** Run → PASS; full suite green.
- [ ] **Step 5 (live, user present):** Install Tailscale on laptop + S24+, enable MagicDNS + HTTPS in the admin console, restart Novi, open `https://<name>:3001` on the phone with Wi-Fi off, pair, talk ("what's the time"), hear the reply, approve a medium approval by voice. Note any latency/voice issue.
- [ ] **Step 6:** Commit message: `Track which device answers each message and approval`.

### Task 3: Remote trust policy + `kind` on approvals

**Files:**
- Create: `server/remoteTrust.js`
- Modify: `server/permissions.js` (`decide({... kind })`, `resolve` consults `trust`, `latest()` skips `kind` items)
- Modify: `server/plugins/host.js` (copy `req.kind` when `'delete'|'payment'`), `plugins/memory/index.js` (`memory_forget` → `kind: 'delete'`), `server/app.js` (send `approval_needs_proof` to the device)
- Test: `tests/server/remoteTrust.test.js`, `tests/server/permissions.test.js`, `tests/server/plugins.test.js`

**Interfaces:**
- Produces: `requiredProof(approval, from, { hasPasskey }) -> null | 'pin' | 'passkey' | 'laptop'`:
  - `from === 'local'` → `null`
  - `approval.kind` in `delete|payment` → `hasPasskey ? 'passkey' : 'laptop'`
  - `approval.tier === 'high'` → `'pin'`
  - else `null`
- `new ApprovalQueue({ grants, trust })`, `trust = { check(approval, from, proof) -> { ok: true } | { ok: false, need } }`. `resolve` returns `false` and emits `needs_proof { id, need, from }` when an allow lacks proof; deny always goes through.

- [ ] **Step 1: Failing tests** — `remoteTrust.test.js` table of the 4 rules above (incl. `kind` + `tier: 'high'` → passkey wins); `permissions.test.js`: `remote allow without proof is refused and stays pending`, `remote deny is accepted`, `local allow unchanged`, `latest() never returns a kind approval`; `plugins.test.js`: `requireApproval kind is carried onto the approval`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Proof verification is injected (`trust` built in `app.js` from Task 4/5 services; until then `check` treats any `pin`/`passkey` need as unmet).
- [ ] **Step 4:** Run → PASS; full suite green.
- [ ] **Step 5:** UI: `ApprovalCards.jsx` shows, on `approval_needs_proof`, "Say your PIN" (pin), "Confirm with fingerprint / face" (passkey) or "This one needs you at the laptop" (laptop). Novi also speaks the same line to that device. Build `npm run build`.
- [ ] **Step 6:** Commit message: `Device-aware approvals: remote critical and delete actions need proof`.

### Task 4: Voice PIN

**Files:**
- Create: `server/remotePin.js`
- Modify: `server/app.js` (`POST /api/remote-pin` local only; `GET /api/remote-pin` → `{ set, pinInput, lockedUntil }`; `PUT /api/remote-pin/settings` local only `{ pinInput }`; WS `{type:'approval', id, allow:true, pinSpoken|pinTyped}`), `src/components/ApprovalCards.jsx` (record PIN with the existing VAD recorder → `/api/stt` → send as `pinSpoken`; typed box only when `pinInput === 'voice-or-typed'`), `src/components/PermissionsPanel.jsx` (set PIN + PIN input setting)
- Test: `tests/server/remotePin.test.js`, `tests/server/app.test.js`

**Interfaces:**
- Produces: `parseSpokenPin(text) -> string | null` (digits and number words en: zero…nine, "oh"; hi: shoonya, ek, do, teen, char, paanch, chhe, saat, aath, nau; ignores punctuation/spaces; 4–8 digits else `null`). `new RemotePin({ file, now })` with `set(pin)`, `isSet()`, `check(pin) -> { ok, locked, lockedUntil }`, settings `getSettings()/setSettings({ pinInput })`. Emits `locked` on the 3rd failure.

- [ ] **Step 1: Failing tests:** `parseSpokenPin('one two three four') === '1234'`, `('1 2 3 4.') === '1234'`, `('ek do teen char') === '1234'`, `('twelve') === null`, `('123') === null`; `RemotePin`: hash stored (file has no plain PIN), correct → ok, 3 wrong → `locked` for 15 min (fake `now`), correct during lock → `{ ok: false, locked: true }`, lock expires; app: `remote critical approval with spoken PIN is allowed`, `with typed PIN is refused when pinInput is voice`, `PIN text never appears in transcript/snapshot`, `POST /api/remote-pin from a remote device → 403`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (`crypto.scrypt`, `timingSafeEqual`). `trust.check` for `need === 'pin'` uses `remotePin.check`. `/api/stt` used for the PIN is the same endpoint; it must not log text (verify; it doesn't today).
- [ ] **Step 4:** Run → PASS; full suite green; `npm run build`.
- [ ] **Step 5:** Commit message: `Voice PIN for remote high-risk approvals`.

### Task 5: Passkeys (fingerprint / face) for remote deletes and payments

**Files:**
- Create: `server/passkeys.js`, `src/lib/passkey.js`
- Modify: `package.json` (`npm install @simplewebauthn/server @simplewebauthn/browser`), `server/app.js` (routes below; `trust.check` for `passkey`; device revoke → `passkeys.removeDevice`), `src/components/DevicesPanel.jsx` or the Settings devices section ("Set up fingerprint / face" on a paired phone), `ApprovalCards.jsx` ("Confirm with fingerprint / face")
- Test: `tests/server/passkeys.test.js`, `tests/server/app.test.js`

**Interfaces:**
- Produces: `new Passkeys({ file, rpId, origin, now, lib })` (`lib` = SimpleWebAuthn functions, injectable for tests): `has(deviceId)`, `async registrationOptions(deviceId)`, `async verifyRegistration(deviceId, response) -> boolean`, `async authOptions(deviceId, approvalId)`, `async verifyAuth(deviceId, approvalId, response) -> boolean`, `removeDevice(deviceId)`.
- Routes (paired device only, `rpId` must exist i.e. Tailscale cert active, else 409 "Needs the Tailscale address"): `POST /api/passkeys/register/options`, `POST /api/passkeys/register/verify`, `POST /api/passkeys/auth/options { approvalId }`. WS approval `{ type:'approval', id, allow:true, passkey: <assertion> }`.

- [ ] **Step 1: Failing tests** (fake `lib`): register stores credential for that device only; `verifyAuth` succeeds once for the bound approval; second use → false; other approval id → false; after 2 min (fake `now`) → false; `removeDevice` deletes credentials; app: `remote delete approval allowed with valid passkey`, `refused with none`, `device without passkey gets need 'laptop'`, `revoking a device removes its passkeys`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `generateRegistrationOptions` / `verifyRegistrationResponse` / `generateAuthenticationOptions` / `verifyAuthenticationResponse` (`authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }`). Client uses `startRegistration` / `startAuthentication`.
- [ ] **Step 4:** Run → PASS; full suite green; `npm run build`.
- [ ] **Step 5 (live):** On the S24+ over Tailscale: set up fingerprint, trigger "forget my test memory" remotely → fingerprint prompt → approved; cancel prompt → stays pending. Set a PIN at the laptop, trigger a high-risk command remotely → say PIN → approved; 3 wrong → locked.
- [ ] **Step 6:** Commit message: `Fingerprint/face confirmation for remote deletes and payments`.

### Task 6: Keep the laptop awake

**Files:**
- Create: `server/laptop/keepAwake.js`
- Modify: `server/index.js` (start after listen, release in `shutdown()`)
- Test: `tests/server/keepAwake.test.js`

**Interfaces:**
- Produces: `startKeepAwake({ spawn }) -> { stop() }`. Spawns a hidden `powershell.exe -NoProfile -NonInteractive -Command <script>` that `Add-Type`s `SetThreadExecutionState` from kernel32, calls it with `0x80000001` (`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`) and then waits on stdin (`[Console]::In.ReadLine()`); `stop()` ends stdin / kills it. Separate process (not the speaker PowerShell) so a speaker restart can't drop the flag. Restart once if it exits unexpectedly.

- [ ] **Step 1: Failing tests** (fake `spawn`): spawns `powershell.exe` with `windowsHide: true` and a script containing `SetThreadExecutionState` and `0x80000001`; `stop()` kills it; unexpected exit → respawned once.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; full suite green.
- [ ] **Step 5 (live):** `powercfg /requests` shows Novi's PowerShell under SYSTEM while Novi runs, gone after stop.
- [ ] **Step 6:** Update `README.md` (Tailscale setup, PIN, passkeys, keep-awake, "lid closed still sleeps") and `CLAUDE.md` state. Commit message: `Keep the laptop awake while Novi runs; remote access docs`.

**Part 2 (next plan):** PWA manifest + service worker, Web Push + `runtime.notify`, missed-update queue, `screen_show`, spoken progress status.
