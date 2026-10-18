# Novi orchestrator: Novi thinks before Claude codes

Date: 2026-10-18 · Status: approved in chat by the user ("YES BUILD IT") · One of the main parts of Novi.

## What the user wants
For a big coding job where Claude is not named ("let's work on portfolio", "make a new project for…",
"build me a…"), Novi first builds a **brief** with AI websites the user chose, shows it, and only on
"yes" hands it to Claude Code. Naming Claude ("tell/ask Claude to…", "Claude, …") and small changes
go straight to Claude as today.

User's choices (2026-10-17/18):
- **ChatGPT website** → the plan (goal, steps, look & feel, done when).
- **Gemini website** → inspiration (3–5 real example sites, what to borrow) **and** security rules.
- **Google Stitch** (UI/UX) → later, after the user sends screenshots of using it (a canvas app, not a
  chat page). Until then "Look & feel" comes from ChatGPT.
- Brief straight away (no questions first).
- The brief is a **card** on the asking device (spoken short version) **and a saved note** in Novi Memory.
- Approach A: the sites are driven through the Novi Chrome extension in **background tabs**; if a site
  fails, the free API for that role answers instead (plan → GitHub Models GPT-4.1, Gemini part →
  Gemini API) and the card says so.

## Flow
1. **Trigger** (no AI): `briefCommand` in `server/brain/briefCommand.js` — runs after the
   Claude-named / rename routes, before the AI. "skip the brief / just do it / no brief" → not a brief.
2. **Reply at once**: "Thinking it through with ChatGPT and Gemini… I'll show you the brief in about a minute."
   The rest runs in the background (like `file_summary`).
3. **Gather facts** (no AI, `plugins/orchestrator/context.js`): README (first 1,500 chars), package.json
   (name, description, script names, dependency names), file list (2 levels, ≤ 60, skipping
   node_modules/.git/dist/build/data/.env*), last 5 commits, the project's brief note if any.
   A new project: "New project, nothing built yet."
4. **Ask both sites at once** (`siteDriver.js`, settings in `sites.json`): a fresh chat each time
   (one remembered tab per site, opened in the background, navigated to the site's start page),
   wait for the message box (20 s; login button / no box → "Log in to X in Chrome…"), type the
   prompt, click send (Enter if no button), wait until the "stop" button is gone and the last answer
   stopped changing (≤ 2 min; nothing started after 15 s → the tab comes forward once), read the last
   answer whole (new extension command `textOf`, keeps line breaks).
5. **Brief** (`brief.js`, no AI): sections Goal · Steps · Look & feel · Examples · Security rules ·
   Done when, each naming its source; spoken: "ChatGPT planned 6 steps and Gemini found 4 examples and
   5 security rules. Send it to Claude?".
6. **Save** the brief to Novi Memory: note "<Project> brief", a dated section each time
   (`runtime.wikiWrite`, from the wiki plugin).
7. **Card** via `runtime.ask` (the normal approval card, never grantable, waits 30 min, details folded
   behind "Show the full brief"):
   - yes (also "yes, also X") → Claude starts with the user's words + the brief (+ "Also: X");
     a new project is created first (`code_new_project`).
   - "change X" / "instead X" → X goes back to ChatGPT in the same chat → a new card (max 3 rounds).
   - no → "Okay, I won't send it."

## Core changes (small)
- `ApprovalQueue.decide({ changeable })`; `resolve(id, false, by, null, { change })` → `{ allow: false, change }`.
- Agent: `changeCommand` (only while a changeable card waits) and the brief route.
- Runtime: `ask`, `startCoding`, `newProject`, `complete(text, { prefer })` (non-private backup AI);
  browser plugin sets `browserRequest`; wiki plugin sets `wikiWrite` / `wikiRead`.
- Extension 1.2.0: `textOf` (whole text of the last match), `open` with `tabId` (navigate that tab).

## Errors
A site failing never stops the brief: that part comes from the backup API, or says "missing". Both
sites and both APIs failing → "I couldn't reach ChatGPT or Gemini (…). Say 'tell Claude to …' to start
without a brief." Chrome not connected → APIs only, card says "Chrome isn't connected, so I used the
backup AIs." Only the user's words and project facts are sent (names, never `.env` contents).

## Testing
Fake bridge pages (like the WhatsApp tests); no real site or real Claude in tests.

## Later
Stitch driver; a debugger role on failed tasks; per-role site choice in Settings.
