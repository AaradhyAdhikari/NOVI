# Novi coding control v1: Claude's questions by voice + live preview

Date: 2026-10-15 · Status: approved in chat, awaiting spec review

## Why

The user wants Novi's main job to be coding control: name a project, give Claude (Claude Code on
the user's Pro plan) the work, follow it by voice, answer Claude's questions by voice, and see the
result on the phone ("show me the homepage"). Progress by voice, permission yes/no and mid-task
changes already exist (`server/claude/*`, CLAUDE.md "Following a coding task by voice"). Two gaps
block the flow:

1. Claude's own questions (`AskUserQuestion`) arrive as a permission request and show as "Claude
   wants to use AskUserQuestion" — there is no way to pick an option.
2. There is no preview: nothing runs the project's site or shows it on the phone.

Later (user's order, not in v1): plan first (read the plan, yes, then build), Pro limit watch
(warn when the 5-hour limit is used, continue at reset), short spoken milestones, quiet mode.

## User decisions (2026-10-15)

- v1 = questions by voice + live preview; the rest later.
- Preview = **picture + live link**.
- **Novi starts the site** (no AI for it; Claude only as the last fallback).
- A question nobody answers: **Claude waits**; one spoken reminder after 5 minutes; the card stays.
- Sample project for the live test: **personal portfolio site** (Home, About, Projects, Contact).
- Novi's brain stays on free models; Claude Code runs on the user's own Pro login (same 5-hour
  limit as their other Claude use — said to the user).

## 1. Claude's questions by voice

**Where:** `server/claude/questions.js` (pure helpers) + `TaskManager._onPermission`.

- `_onPermission` sees `toolName === 'AskUserQuestion'` → never classified as a permission. For each
  entry of `input.questions` (`{ question, header?, options: [{ label, description? }], multiSelect? }`),
  in order, Novi asks through the approval queue with `choices` = the options (`id` = `o1`, `o2`, …)
  and a new approval field `question: true`, `timeoutMs: null` (no timeout), `source: 'claude'`.
- Spoken (`spokenQuestion`): `"Claude asks: <question>? One, <label>. Two, <label>. …"` (labels only,
  at most 4; descriptions stay on the card). The card shows the question, the options with
  descriptions, and "Or say your own answer".
- Answers (`matchAnswer(text, options)`, no AI): a number word in English / Hindi / Marathi
  ("one", "1", "first", "pehla", "ek", "doosra", "do", "second", "teesra", "third", "last",
  "aakhri"), optionally with "one / option / wala / vala"; or the option label (whole label or one
  of its distinctive words, case-insensitive). Anything else said while the question waits is the
  user's own answer (free text). multiSelect: several numbers/labels joined by "and / aur / ,".
  "cancel / skip" = no answer: Claude is told "The user skipped this question; choose sensibly and
  say what you chose."
- Reply to Claude: `{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: answer } } }`
  where `answer` is the option label (multi: labels joined by ", ") or the user's own words.
- Waiting: no timeout; `setTimeout` 5 min → `runtime.say("Claude is still waiting: <question>?")`
  once (to the last-used device). Stopping the task resolves the open question as skipped.
- Voice routing: while a `question` approval waits, `agent.handle` sends the words to
  `matchAnswer` first (before quick commands, YouTube follow-up, the AI); the approval is resolved
  with `{ answer }`. Ordinary yes/no approvals keep their current path.
- The UI approval card renders `question` approvals: options as buttons + a text box for an own
  answer (tap works too; voice is the main way).

## 2. Live preview

**Where:** new plugin `plugins/preview/` (OpenClaw shape): `run.js` (how to run), `server.js`
(child process per project), `proxy.js` (preview port), `index.js` (tools + service).

**How to run a project (no AI), first match wins:**
1. `<project>/.novi/run.json` — `{ "command": "npm run dev", "port": 5173, "pages": { "home": "/", "contact": "/contact" } }`.
   Claude is asked to write it: the Claude system-prompt line (session.js `--append-system-prompt`)
   gains "If the project has a website, write .novi/run.json with the command to start it, its port
   and its pages."
2. `package.json` scripts: `dev`, else `start` (`npm run <script>`); port read from the script's
   output (first `http://localhost:<port>` line within 30 s).
3. `index.html` in the project (or `public/`, `dist/`) → Novi serves the folder itself (static).
4. None → `code_send_message` "Please start the website so it can be previewed, and write
   .novi/run.json." and the user hears "I asked Claude to start the site."

The child runs hidden in the project folder, not elevated, one per project, stopped on "stop the
preview", when the task is stopped/renamed, and at Novi shutdown. Output kept (last 200 lines) for
errors ("The site didn't start: <last error line>").

**Preview port:** Novi listens on `NOVI_PREVIEW_PORT` (default 3005), HTTPS with Novi's cert,
reverse-proxying everything (HTTP + WebSocket, for hot reload) to the project's port, so the site
is at the root of its own address (absolute `/assets/…` paths keep working). Access: a link
`https://<host>:3005/?novi=<token>` — token random, single project, valid 30 minutes; the first
request with a valid token sets an HttpOnly cookie; requests without a valid cookie/token get 403.
Tokens are given only in a reply to a paired device (or the laptop). `<host>` = the host name the
asking device used to reach Novi (its WebSocket's Host header: Tailscale name/IP on the phone,
localhost on the laptop).

**Tools:** `preview_show { page?, project? }` (current task's project by default): start if needed
→ picture (existing hidden-Edge `pageShot`, now with a phone size 390×844 option) of the page →
`runtime.showImage` to the asking device + a tap-to-open link via a new `runtime.showLink({ url, title })`
(built on the existing `link` transcript extra used for phone links) → note "Here's the contact page. Tap the link to open it live." `preview_stop`.
Pages: `run.json` pages → a link on the home page whose text matches the page word → home (said:
"I couldn't find a contact page, so here's the homepage.").

**Voice (no AI):** `previewCommand` in `server/brain/`: "show me the (home/contact/about/…)
page / homepage / the site / website", "preview dikhao", "homepage dikhao", "stop the preview".
Only when a project is known (running/last task or named); otherwise the brain.

**Approvals:** starting a project's own dev server = running the project's code → asks once per
project per Novi run ("Start the portfolio site to preview it?"), grantable category `preview`.
Static serving and pictures don't ask.

## Errors

No project → "Which project? Say 'show me the homepage of portfolio'." · run.json command fails →
the last error line, and Claude is not asked automatically · port never appears in 30 s → "The site
didn't say which address it uses." · Edge missing / page doesn't load → link only, said so ·
Claude not running for a question → no question can exist (questions only come from a running
session).

## Testing

Vitest, fake Claude only (`tests/fixtures/fake-claude.mjs` gains an AskUserQuestion step):
- questions.js: spoken text; `matchAnswer` by number (en/hi/mr), label, distinctive word, own
  words, multiSelect, skip.
- TaskManager: AskUserQuestion becomes a question approval (not a permission), several questions
  one by one, no timeout, 5-minute reminder (fake timers), stop → skipped, answer → updatedInput.
- agent: while a question waits, "doosra" / "dark" / "make it purple" resolve it; yes/no
  approvals unchanged.
- preview run.js: run.json / package.json dev / start / static / none.
- proxy: 403 without token, token → cookie → 200, wrong project token refused, WebSocket upgrade
  forwarded, expired token refused.
- tool: picture + link go to the asking device; unknown page → home with the note.
- previewCommand phrases.

Live checklist (laptop + phone): "make a portfolio site in a new project called portfolio" → Claude
asks about the theme → answer "doosra" by voice → "show me the homepage" on the phone → picture +
link opens live → "show me the contact page" → "stop the preview".
