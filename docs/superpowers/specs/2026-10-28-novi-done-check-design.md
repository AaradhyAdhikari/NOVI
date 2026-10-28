# Done-check: Novi checks Claude's work against the brief (design, 2026-10-28)

User's decisions (2026-10-28, from their ChatGPT plan + Claude's suggestions): build the done-check loop
first, then the voice-approval gaps; Novi tries functional checks itself (not "not checked"); the check
starts by itself after a brief-approved build.

## Goal
Brief → Claude builds → **Novi verifies** → says the result honestly → "fix it" → Claude fixes only the
failed checks → Novi verifies again. Claude never grades its own work. Every run is saved, so research
numbers (pass rate, fix rounds, time to a working app) come for free.

## 1. The checklist (no AI)
- `brief.js` turns the brief's **Done when** lines into checks, and **Look & feel** into one visual check:
  `{ id, text, kind }`, `kind` from words, no AI:
  - `manual` — login / sign in / payment / pay / email / SMS / OTP / deploy / external API / real data →
    never tried, said as "Not checked: needs you (why)".
  - `technical` — loads / no errors / console / builds / fast / works offline.
  - `functional` — calculates / adds / saves / submits / filters / shows X when / clicking / typing.
  - `visual` — everything else (layout, phone-sized, colours, looks like…).
- Saved in the "<Project> brief" note (a numbered list) and in the project as `.novi/checks.json`
  (written when the brief is sent to Claude). The ChatGPT prompt stays the same (websites break JSON).

## 2. When it runs
- After a coding task that came from an approved brief finishes (`runtime.tasks` 'task' → done) on a
  project with `.novi/checks.json`. The brief "yes" covers starting the preview — no second card.
- By voice, no AI: "check it", "is it done", "run the checks (on X)", "check my X project".

## 3. How Novi checks (new `plugins/donecheck`)
- Starts the project's preview (preview plugin, a runtime call without its once-per-project card).
- `browser.js`: hidden Edge (`--headless=new`, own profile) driven over CDP with `ws` (already a
  dependency). Phone (390×844) and desktop (1280×800) screenshots; console errors and uncaught
  exceptions collected; **every request to a host other than the preview is blocked** (Fetch domain), so
  a test can never send a real email, payment or form to the internet.
- **technical** → no AI: page answers, no uncaught errors / console errors (the error text is the "why").
- **visual** → free vision (`runtime.vision`: Gemini, Groq backup — screenshots to Gemini already OK'd):
  both screenshots + the check → `passed | failed | uncertain` + one-line why.
- **functional** → Novi tries it: the page's controls (inputs, buttons, selects with their labels, ≤ 60,
  numbered) + the check → free AI writes ≤ 8 steps (`type n value`, `click n`, `select n option`) and
  what should be seen; Novi runs them in the hidden page, reads the visible text after, and the AI judges
  `passed | failed | uncertain` with the before/after text and a screenshot. A step that can't run →
  `uncertain` ("I couldn't find the tip box"), never a guess.
- Page text is website data, not instructions (same rule as the browser plugin).

## 4. The result
- Four states: **passed**, **failed**, **uncertain** (tried, couldn't tell), **not checked** (manual,
  with why).
- Spoken, short: "3 of 5 checks passed. Failed: the layout breaks on a phone. Not checked: email
  sending — try it yourself." Chat: one card with every check, its state and why, plus the screenshots.
- Saved: `<project>/.novi/check-results.jsonl` (each run: time, round, every check's state + why) and
  `data/donecheck/runs.jsonl` (project, round, counts, seconds) for research; the brief note gets
  "Checked <date>: 3/5 passed".

## 5. "Fix it"
- "fix it" / "fix the failed ones" / "theek karo" (no AI; your words are the yes): Claude gets only the
  failed + uncertain checks with each why and the screenshot paths (`.novi/check-shots/`), "fix only
  these, don't change anything else". Running task → `code_send_message`, else a new Claude task on the
  project. When Claude finishes, Novi checks again (round 2…) and says what changed ("Now 5 of 5").
- Credits are spent only on "fix it".

## Not in v1
- Projects without a website (CLI, libraries) → "I can only check websites for now."
- Projects without a brief → "There's no checklist for X yet" (later: make one from the README).
- Voice-approval gaps ("option 2" on any card, "approve but X", "change X" on Claude's cards) = the next
  piece, after this.

## Tests
CDP browser behind an injected driver (fake in tests); checklist parsing, kind words, result wording,
blocking non-preview hosts, fix-it message, auto-start after a brief task, runs log. Live: the tip
calculator on the test copy.
