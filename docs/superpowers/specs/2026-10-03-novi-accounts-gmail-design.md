# NOVI — Accounts Core + Gmail — Design Spec

Date: 2026-10-03
Status: Draft for review
Builds on: `docs/superpowers/specs/2026-10-01-novi-mvp-design.md` (router, agent, approvals, tiers)

## 1. Goal

Let Novi use the user's accounts after a one-time, user-approved connection, starting with Gmail:

> "Summarize my college inbox." · "Read me the email from Amazon." · "Email Sir that I'll be late." (shows the full email, sends only after Allow)

Success criteria:

1. The user connects one or more Google accounts through Google's own consent screen; Novi never sees a password.
2. Multiple accounts: the user can name an account (label or email); with several connected and no default, Novi asks which one; a per-provider default can be set and cleared by voice.
3. Reading (search, read) runs without approval; sending always shows an approval card with the sending account, recipients, subject and full body.
4. Access tokens are encrypted at rest with the Windows user's DPAPI; disconnecting deletes them locally and revokes them at Google.
5. Email content is only ever sent to Groq (never to Gemini's free tier, which may use content to improve Google products).
6. Zero paid usage, no Claude usage.

## 2. Scope

**In:** accounts registry (multi-account, labels, defaults), secret store (DPAPI), Google OAuth for installed apps (loopback + PKCE), Gmail search/read/send(+reply), account resolution rules, privacy routing for mail content, Settings → Accounts UI, brain tools and prompt.

**Out (later sub-projects):** GitHub (device flow), Novi Browser + browsing agent (LeetCode and other sites), Gmail delete/archive/labels, attachments (sending or downloading), calendar/drive.

## 3. Architecture

```
 UI Settings → Accounts  ─┐            brain tools
 "connect my gmail"       │  accounts_list · accounts_set_default · gmail_connect
                          ▼  gmail_search · gmail_read · gmail_send
 ┌─────────── Novi server ─────────────────────────────────────────┐
 │ accounts/registry.js   data/accounts.json (no secrets)          │
 │ accounts/secrets.js    DPAPI protect/unprotect (PowerShell)     │
 │ accounts/resolve.js    which account? (named/default/only/ask)  │
 │ google/oauth.js        loopback + PKCE consent, token refresh,  │
 │                        revoke                                   │
 │ google/gmail.js        REST: search, get, send (RFC 2822)       │
 │ tools/accountTools.js  brain tools above                        │
 │ brain/agent.js         privacy: turns that read mail → Groq only│
 └─────────────────────────────────────────────────────────────────┘
```

## 4. Components

### 4.1 Accounts registry (`server/accounts/registry.js`)
- `data/accounts.json`: `{ accounts: [{ id, provider: 'google', email, label, scopes, connectedAt, status: 'connected'|'expired' }], defaults: { google: <accountId>|null } }`. No tokens in this file.
- Labels are lower-cased; unique per provider; default label = the email's local part until the user renames ("call it college").
- Operations: `list(provider?)`, `add(account)` (re-connecting the same email replaces it), `remove(id)`, `setLabel(id, label)`, `setDefault(provider, id|null)`, `markExpired(id)`.

### 4.2 Secret store (`server/accounts/secrets.js`)
- `protect(plain) → blob` and `unprotect(blob) → plain` using Windows DPAPI (current user) via `powershell.exe -NoProfile` with the secret passed on **stdin** (never on the command line). Blobs stored in `data/secrets.json` keyed by account id.
- Non-Windows fallback: AES-256-GCM with a key file `data/secret.key` (permissions 600). Tests inject a fake.

### 4.3 Account resolution (`server/accounts/resolve.js`)
`resolveAccount(accounts, provider, requested, defaults)`:
1. `requested` given → match label exactly, else email exactly, else unique prefix of label/email → that account; no match → `{ error: 'No Gmail account called "x". Connected: personal, college.' }`.
2. Not given, exactly one connected → it.
3. Not given, default set → default.
4. Not given, several, no default → `{ ask: [{label, email}…] }` — tools return this as a question; the brain asks the user and calls again with `account`.
5. None connected → `{ error: 'No Gmail account is connected yet — say "connect my Gmail".' }`.
- `requested = 'all'` is accepted only by `gmail_search`.

### 4.4 Google OAuth (`server/google/oauth.js`)
- Credentials from `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Desktop-app client; the secret is not confidential for installed apps).
- Connect: start a one-shot HTTP listener on `127.0.0.1:<random port>`; open the consent URL on the laptop (`openUrl`) with `scope = gmail.readonly gmail.send openid email`, `access_type=offline`, `prompt=consent`, PKCE S256, random `state`. On callback: verify `state`, exchange code, read `email` from the ID token / userinfo, store refresh token via secret store, add to registry. Listener closes after success, error, or 5 minutes. Callback page says "Novi is connected — you can close this tab."
- Access tokens cached in memory until 60 s before expiry; refreshed with the refresh token. `invalid_grant` → account marked `expired`, user told to reconnect.
- Disconnect: revoke at `https://oauth2.googleapis.com/revoke`, delete secret, remove from registry (also if revoke fails — local removal still happens).
- Note in setup docs: publishing status "In production" avoids Google's 7-day refresh-token expiry for "Testing" apps.

### 4.5 Gmail client (`server/google/gmail.js`)
REST via `fetch` (no SDK):
- `search(token, { query, max = 10 })` → `GET users/me/messages?q=&maxResults=` then `format=metadata` (From, To, Subject, Date) per id → `[{ id, threadId, from, subject, date, snippet, unread }]`.
- `read(token, id)` → `format=full`; returns headers + plain-text body (prefers `text/plain`, else HTML stripped to text), capped at 8 000 characters with a truncation note.
- `send(token, { from, to, cc?, subject, body, replyTo? })` → builds RFC 2822 (UTF-8, base64url, `Subject` RFC 2047-encoded when non-ASCII). For replies: `In-Reply-To`/`References` from the original `Message-ID`, `threadId` set, subject prefixed `Re:` if missing.
- HTTP 401 → refresh once and retry; 403/429 → user-facing "Gmail refused/slowed the request".

### 4.6 Brain tools (`server/tools/accountTools.js`)

| Tool | Tier | Behaviour |
|---|---|---|
| `accounts_list` | low | Connected accounts with labels, emails, defaults, status |
| `accounts_set_default` | low | Set/clear the default account for a provider (`account: null` clears) |
| `accounts_rename` | low | Change an account's label |
| `gmail_connect` | low | Opens Google's consent page on the laptop; returns immediately ("finish in the browser") |
| `gmail_search` | low | `{ query?, account?, max? }`; query uses Gmail syntax (`from:`, `is:unread`, `newer_than:2d`); default `in:inbox newer_than:7d`; `account: 'all'` searches every account and tags results |
| `gmail_read` | low | `{ id, account? }` |
| `gmail_send` | medium | `{ to, subject, body, cc?, reply_to_id?, account? }` → approval title `Send from <label> (<email>) to <to>: <subject>`, detail = full body; sends only on Allow |

Disconnect is UI-only (Settings → Accounts → Disconnect), not a brain tool.

### 4.7 Privacy routing (`server/brain/agent.js`, `server/brain/router.js`)
- Tools may return `sensitive: true` (all `gmail_search` / `gmail_read` results do).
- Private providers come from `NOVI_PRIVATE_PROVIDERS` (default `groq`). After a sensitive tool result, the rest of that agent turn stays on its provider only if that provider is private (it is already pinned per turn).
- If the turn is running on a non-private provider (e.g. Groq was down so it started on Gemini), the sensitive result is **not** passed to the model: the turn ends with "I can't read your mail right now — my private AI provider is busy. Try again in N seconds." If the private provider fails mid-turn, same reply; no fallback for that turn.
- Conversation history kept for later turns contains only Novi's spoken replies, never raw email bodies.

### 4.8 UI — Settings → Accounts (`src/components/SettingsDrawer.jsx`)
- List: provider icon, label, email, status (connected / expired), "default" badge.
- Actions: Connect Gmail, Set as default, Rename, Disconnect (confirm dialog).
- If `GOOGLE_CLIENT_ID` is missing, Connect shows the setup steps instead.

## 5. Data flow (example)

1. "Email Sir I'll be late" → brain calls `gmail_send` without `account`.
2. Two accounts, no default → tool returns `{ ask: [personal, college] }` → Novi: "Which account — personal or college?"
3. "College" → brain calls `gmail_send({ account: 'college', to, subject, body })` → approval card shows sender, recipient, full body → Allow → sent → "Sent from your college account."

## 6. Error handling

| Failure | Behaviour |
|---|---|
| Google credentials missing | Connect explains setup; tools say "Gmail isn't set up yet" |
| Consent cancelled / timed out | Listener closes; "Gmail connection was cancelled" |
| Refresh token revoked/expired | Account → expired; "Reconnect your college Gmail in Settings" |
| Gmail 401 | Refresh once, retry once |
| Gmail 403/429/5xx | Plain spoken error, no retry storm |
| DPAPI failure | Connect fails with a clear message; nothing half-saved |
| Private provider unavailable during mail turn | Refuse to fall back; say when to retry |

## 7. Testing
- Unit (Vitest): registry CRUD + defaults; resolution rules (named/label/email/prefix/only/default/ask/none/all); secret store with fake DPAPI runner (stdin used, not argv); OAuth URL (PKCE, state, scopes) and callback handling with fake token endpoint; token refresh + `invalid_grant`; Gmail search/read parsing from recorded JSON fixtures (multipart, HTML-only, non-ASCII subject); RFC 2822 builder (reply headers, encoded subject); tools (ask flow, all-accounts search, send approval title/detail, denial); privacy routing (sensitive → `only: groq`, refusal when Groq down, history excludes bodies).
- Live (user present): connect real account, read-only `gmail_search`/`gmail_read`. A real send only when the user asks, to an address they choose.

## 8. User prerequisites
1. Google Cloud project "Novi" with Gmail API enabled.
2. OAuth consent screen: External, user added as test user, publishing status **In production**.
3. OAuth client type **Desktop app**; `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` (entered by the user).
