# Novi routines: jobs set up from your words (design, 2026-11-13)

## Why
The user wants to hand Novi recurring jobs in plain words ("every morning check my GitHub and tell me what
changed", "when a coding task finishes, tell me what changed and how the board looks", "every Friday evening sum up the team's
week") and have them run by themselves, with one yes up front and a small report card each time. It is the
step the user picked after smart routing (2026-11-10) and the first part of "routines and agents made by
Novi from the user's words".

## Goals
- Describe a job in your own words (voice or typed); Novi turns it into a routine: **when** (a time
  pattern or an event) + **steps** (fixed tool calls, in order) + a short **report**.
- One card shows exactly what the routine will do; a yes saves it.
- It runs by itself, replays the same steps (no AI planning per run), and reports on a small card
  (`runtime.notice`), spoken where you last were.
- List, run now, pause/resume and remove routines by voice.

## Non-goals (this version, user chose "A: look and report only")
- No routine that sends, commits, deletes, pays, types, clicks, opens apps/sites or changes settings.
  Those always stay behind their own card. (Option B, "changes allowed after the first yes", is later.)
- No AI deciding new steps on each run (that was approach 3, not chosen).
- No routine runs any code: not the project's tests, not the done-check (user, 2026-11-13: "strictly look only"). Running tests stays a request you make yourself.
- No routines on the phone app side; they run on the laptop's Novi.

## Anti-goals (a failure even if it works)
- A routine doing something the card didn't show.
- A routine quietly changing anything.
- Noise: cards every few minutes, or a report for runs that found nothing when you asked only for changes.
- Spending the free AI quota on every run.

## Approaches considered
1. **Extend reminders** (repeat + one look-up already exist): least code, but muddles reminders and events
   don't fit them. Not chosen.
2. **A new routines plugin with fixed steps (chosen by the user).** The AI plans once from the words; the
   card shows the plan; runs replay it; the existing `runtime.callTool` already refuses any tool that needs
   approval, and a look-only allow-list keeps out tools that change things without a card.
3. **A goal given to the AI each run**: flexible but costs AI each run, varies run to run, stops when the free
   AI is busy. Not chosen.

## Design
New plugin `plugins/routines` (OpenClaw shape, like every feature).

**A routine** (`data/routines/routines.json`, ≤ 20): `{ id, name, said (the user's words), when, steps,
report, onlyChanges, paused, created_at, last_run, last_result_hash, fails }`.
- `when`: `{ every: <reminders repeat string> , at: 'HH:MM' }` (daily / weekdays / given days / every N hours,
  parsed with `plugins/reminders/parse.js` `parseRepeat` / `parseWhen` / `nextOccurrence`), or
  `{ on: 'coding_done' | 'team_task' }`. Smallest gap: 1 hour.
- `steps`: 1–6 `{ tool, params, label }`. Every `tool` must be on the **look list**.
- `report`: one line of what to tell ("what changed on GitHub since yesterday").
- `onlyChanges`: true when the words ask only for changes ("tell me what changed", "if anything new"): a run
  whose step outputs are the same as last time (hash) makes no card.

**The look list** (`look.js`): an explicit allow-list of read-only tools, e.g. weather_get, github_activity,
github_repo, github_graph, leetcode_today, leetcode_stats, project_board, project_status, project_about,
team_status, project_said, code_changes, calendar_events, calendar_free, tasks_list, notes_ask, notes_list,
brain_search, web_search, web_read, laptop_battery, laptop_disk, claude_usage, claude_activity,
reminder_list, preview_status. A tool joins only by being added here (reviewed), never by guessing from its
name. Running still goes through `runtime.callTool` (which refuses anything with a card) — two locks.

**Making one** (`plan.js`): `routine_make { said }` → `runtime.complete` (free AI; private turns not needed:
the words are the user's own request) with the look list's one-line descriptions → strict JSON → validated
(`validate`: known look tools only, params are plain values, ≤ 6 steps, a parsable `when`, gap ≥ 1 h).
Anything off → one clear question back ("I can only look things up in a routine; sending a message isn't one
of them."), nothing saved. Then one card (`runtime.ask`, normal approval, `timeoutMs` 10 min):
title "New routine: <name>?", detail = when (plain words) + numbered steps (labels) + "It only looks things up
and tells you; it never sends, changes or deletes anything." Yes → saved; no → nothing.

**Running** (`runner.js`): each step via `runtime.callTool` in order; a failing step is noted and the rest
still run. Report: step outputs (text only, each cut to 1,500 chars, marked as data) → `runtime.privateComplete`
(Groq) "say in ≤ 3 short sentences what the user asked: <report>" → `runtime.notice({ key: 'routine-<id>',
title: <name>, body, spoken })`; no AI → the first lines of each output. 3 failed runs in a row → paused +
a card "<name> keeps failing: <why>. Paused." A run log (last 200) in `data/routines/runs.jsonl`.

**Triggers** (`schedule.js`): one timer for the next due time routine; a run missed while the laptop was off
or Novi down runs once at start (one catch-up, like `server/daily.js`). Events: `runtime.tasks` 'task' done →
`coding_done` routines; the agents plugin calls `runtime.routineEvent?.('team_task', { project, task })` when a
team task reaches review. Events are debounced (one run per 5 min per routine).

**Voice** (`server/brain/routineCommand.js`, no AI to recognise, in DIRECT_OK):
- make: "every <when> <look verb …>", "each morning …", "whenever/when a coding task finishes, …", "make a
  routine (to/that) …", "har subah …" → `routine_make { said }` (the plan itself uses the AI once).
- "list/what are my routines" → `routine_list`; "run the X routine (now)" → `routine_run`; "pause/stop the X
  routine", "resume the X routine" → `routine_pause`; "remove/delete the X routine" → `routine_remove`.
- Reminders keep their own words ("remind me …"); "every morning tell me the weather" may stay a reminder —
  the routine route takes it only when there are two or more look things or an event.

**Safety**: look list + callTool gate; params never contain paths outside the user's projects unless the tool
itself already allows it; outputs go to the AI only as data for the summary; the card is the only way in;
AI-chosen `routine_make`/`routine_remove` ask first, your words don't.

## Decisions after the builder check (Claude's calls, user may change)
- **Event details in steps:** an event routine's params may use `{project}` (and `{task}` for team tasks), filled from the event; nothing else is filled in.
- **"What changed":** the summary AI gets this run's outputs and the previous run's (both marked as data) and says what's different; outputs are cleaned of times/dates/"N min ago" before the change check, so a run that only moved a clock isn't a change. The first run of an only-changes routine reports what it sees ("first look").
- **coding_done** fires once per finished coding task (Claude or Novi Coder, deduped by task id), only when it finished well (not failed/stopped).
- **team_task** fires from the agents plugin when a task's review card is about to show (one place covers text and build tasks); `runtime.routineEvent` is set by the routines plugin.
- **Times:** `at` is a 24-hour HH:MM read by the routines plugin's own parser (reminders' `parseWhen` reads 7 as 7 or 19); "every N hours" runs around the clock from the time it was made (reminders' 8–22 window doesn't apply); each routine keeps its own next-run time, and one missed run catches up once at start.
- **Cards:** the plan card `timeoutMs` 10 min; an AI-chosen routine_make shows the plan card only (one card, not two); the report card body stays within the 200-character card limit (the full report is kept in the run log and read by "what did the X routine say"); a routine that keeps failing gets a small OK card, not a question; quiet mode drops the spoken part as for any line.
- **Outputs:** read from a tool's `details` as well as its text (built-in tools put their data there).
- **Limits:** 20 routines; a name already used gets "(2)"; at the limit → "You have 20 routines; remove one first."

## Left to the builder
Exact look list membership after reading each tool; wording of cards; the JSON shape the planner returns;
where in `agents` to fire `team_task`; tests per piece (TDD), then a live run on the test copy.
