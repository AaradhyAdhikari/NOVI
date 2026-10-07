# One-time permission grants — design (2026-10-08)

Goal: stop asking about safe, repetitive actions while risky ones always confirm. Roadmap item 4.

## 1. Categories (`server/grants.js` → `classifyApproval`)
Every approval gets a **category** and a **grantable** flag.

| Category | Label on card / Settings | What falls in it |
|---|---|---|
| `files` | Editing files in a project | Coder edits inside the task's project (outside = high, never) |
| `commands` | Running commands in a project | Coder shell commands that are not on the high-risk list |
| `apps` | Opening apps and projects | laptop / ide plugins (most are already no-approval) |
| `browser` | Browser actions | future browser agent |
| `screen` | Screen control (click, type) | `plugins/screen` click / type / key / scroll |
| `projects` | Remembering projects | `remember_project` |
| `announce` | Announcements | `clock_announce` |
| `github-read` | Marking GitHub notifications read | `github_mark_read` |
| otherwise | plugin id | derived from the tool's plugin |

Order: a plugin may name its own `requireApproval.category` (and `grantable: false`), then an explicit map in `grants.js`, then the plugin id.

**Never grantable** (always ask, no "always" button):
- `critical` / high tier (screen-only confirmations, coder commands on the high-risk list, edits outside the project);
- approvals that carry `choices` (e.g. "use Claude instead" — the choice matters each time);
- anything that sends, posts, deletes or pays: explicit list (`gmail_send`, `github_comment`, `github_create_issue`, `memory_forget`, `reminder_cancel`, `forget_project`, `code_start_task`) plus a name check (`send|post|comment|delete|remove|forget|cancel|pay|purchase|buy|transfer|publish|issue`);
- a plugin that says `grantable: false` (the screen plugin does this for typing into anything that looks like a password/payment field — those are blocked anyway).

Admin changes go through Windows UAC; Novi never tries to bypass it, and no grant skips UAC.

## 2. Storage (`data/permissions.json`)
```json
{ "grants": { "screen": { "grantedAt": "…", "by": "voice" } },
  "audit": [ { "at": "…", "category": "screen", "title": "Click “Send” in WhatsApp" } ] }
```
`PermissionGrants` class: `has / grant / revoke / list / record / audit`. The audit keeps the newest 200 auto-allowed actions.

## 3. Flow
- `ApprovalQueue` gets the grants store. `decide({ …, category, grantable })`:
  - granted + grantable + medium tier → resolves **immediately** with `{ allow: true, auto: true }`, writes the audit, emits `auto_allowed` (the UI shows a small "Auto-allowed: …" line in the chat feed, not spoken).
  - otherwise the card is shown as today; grantable cards carry `grant: { category, label }`.
- Card: grantable cards get a third button **"Always allow <label>"** → `{ type: 'approval', id, allow: true, always: true }` → allows this one and stores the grant.
- Voice: "yes always", "always allow", "allow always", "yes, always allow it" → `approve-always` (only applies to the latest grantable card; otherwise it is a plain yes and Novi says it can't remember that one).
- The agent (plugin tools) and the coder task manager (files / commands) both pass category + grantable.
- The coder's existing "allow edits for this task" switch stays (per-task); the `files` grant is the permanent version.

## 4. Settings → Permissions
`GET /api/permissions` → `{ grants: [{ category, label, grantedAt }], audit: [...] }`; `DELETE /api/permissions/:category` revokes. The panel lists grants with a revoke button and the last 20 auto-allowed actions.

## Not now
- Per-app or per-project scoped grants (e.g. "screen control only in Notepad"). Category-wide is what was agreed; revisit if it feels too broad.
- Voice PIN for high-risk approvals (roadmap item 2, separate).
