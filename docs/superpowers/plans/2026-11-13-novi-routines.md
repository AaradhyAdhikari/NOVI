# Novi Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jobs the user describes in words become look-only routines (when + fixed steps + report) that run by themselves and report on a small card.

**Architecture:** New plugin `plugins/routines` (OpenClaw shape). The AI plans a routine once (`runtime.complete` → JSON → validated against a reviewed look list); one card saves it; a per-routine scheduler and two events replay the fixed steps through `runtime.callTool`; `runtime.privateComplete` writes a ≤ 3-sentence report shown with `runtime.notice`. Voice words in `server/brain/routineCommand.js`.

**Tech Stack:** Node ESM, `#plugin-sdk` `definePluginEntry`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-novi-routines-design.md`

## Global Constraints
- Look and report only: a step's tool must be on `LOOK_TOOLS`; no tests, done-check, sends, commits, deletes, typing, clicking, opening apps/sites, settings (user: "strictly look only").
- Steps run only via `runtime.callTool` (refuses anything with a card) — never `tool.run` directly.
- ≤ 6 steps; ≤ 20 routines; smallest gap 1 hour; `at` is 24-hour HH:MM.
- Plan card `timeoutMs: 600_000`; report card body ≤ 200 chars, title ≤ 120.
- Event params may use only `{project}` and `{task}`.
- The user makes the commits: no `git commit` in any step; Novi's commit card comes by itself after the work.

## Review Focus
- The AI's plan names a tool not on the look list, or a changing tool → nothing saved, one plain line back (Task 2).
- A routine due while Novi was off → runs once at start, not once per missed slot (Task 4).
- A coding task's 'task' event fires many times → the routine runs once per task id (Task 4).
- Outputs that only differ by a clock/date ("3 min ago", "13 Nov") → an only-changes routine stays quiet (Task 3).
- A step throws → the others still run, the report names the failed step; 3 failed runs in a row → paused + small card (Task 3).

---

### Task 1: Look list, routine store, schedule maths

**Files:**
- Create: `plugins/routines/look.js`, `plugins/routines/store.js`, `plugins/routines/schedule.js`
- Test: `tests/server/routinesCore.test.js`

**Interfaces:**
- Produces: `LOOK_TOOLS: string[]` (exactly the spec's list: weather_get, github_activity, github_repo, github_graph, leetcode_today, leetcode_stats, project_board, project_status, project_about, team_status, project_said, code_changes, calendar_events, calendar_free, tasks_list, notes_ask, notes_list, brain_search, web_search, web_read, laptop_battery, laptop_disk, claude_usage, claude_activity, reminder_list, preview_status); `isLook(name): boolean`.
- Produces: `createStore({ file }) → { list(), get(id), add(routine) → routine | { error }, update(id, change), remove(id), byName(name) }` — `add` assigns `id`, `created_at`, dedupes name with " (2)", refuses a 21st ("You have 20 routines; remove one first.").
- Produces: `parseAt(text): {h, m} | null` (24-hour "07:00", "7:30", "19:05"; nothing else); `nextRun(when, from: Date): Date | null` — `when = { every: 'daily'|'weekdays'|'weekly:mon,thu'|'hourly:N', at?: 'HH:MM' }` → the next time strictly after `from`; hourly runs around the clock from `from`; `{ on }` → null. `describeWhen(when): string` ("every day at 07:00", "every weekday at 09:30", "every Mon, Thu at 18:00", "every 3 hours", "when a coding task finishes", "when the team finishes a task").

- [ ] **Step 1: Write the failing tests** — `isLook('weather_get')` true, `isLook('whatsapp_send')`/`isLook('code_tests')`/`isLook('donecheck_run')` false; store add/dedupe/limit/remove/persist (fresh store on same file sees it); `parseAt('7:00')` = {7,0}, `parseAt('19:05')` = {19,5}, `parseAt('7pm')` = null; `nextRun({every:'daily',at:'07:00'}, 2026-11-13T08:00)` = 2026-11-14T07:00; weekdays from Fri 10:00 at 09:30 → Mon 09:30; `weekly:mon,thu` at 18:00 from Thu 17:00 → same Thu 18:00; `hourly:3` from 23:00 → 02:00 next day; `{on:'coding_done'}` → null.
- [ ] **Step 2: Run** `npx vitest run tests/server/routinesCore.test.js` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three files (store = atomic JSON write like other plugins; schedule uses its own day maths, not reminders' `alignToRepeat`).
- [ ] **Step 4: Run** the same command — Expected: PASS.

### Task 2: Planning a routine from words

**Files:**
- Create: `plugins/routines/plan.js`
- Test: `tests/server/routinesPlan.test.js`

**Interfaces:**
- Consumes: `LOOK_TOOLS`, `isLook`, `parseAt`, `describeWhen` (Task 1).
- Produces: `planPrompt(said, catalog: string[]) → string` (catalog = one line per look tool: "name: description"; asks for JSON `{name, when:{every,at}|{on}, steps:[{tool,params,label}], report, onlyChanges}`).
- Produces: `validate(plan, { look = isLook } = {}) → { routine } | { error: string }` — errors (exact): unknown/changing tool → `I can only look things up in a routine; ${tool} isn't one of those.`; 0 or > 6 steps → `A routine has 1 to 6 steps.`; bad when → `I couldn't tell when it should run. Say a time like "every day at 7:00" or "when a coding task finishes".`; hourly:N with N < 1 → same when error; params must be plain strings/numbers/booleans (no objects) else `Those steps look wrong; say it again a bit differently.`; `{project}`/`{task}` allowed only when `when.on`.
- Produces: `planRoutine(said, { complete, catalog }) → Promise<{ routine } | { error }>` — parses the first `{…}` JSON in the reply; a reply that isn't JSON → the "say it again" error.

- [ ] **Step 1: Write the failing tests** — a good plan validates (name kept, label kept); `whatsapp_send` step → the exact "isn't one of those" error; `code_tests` step → same; 7 steps → "1 to 6"; `{every:'hourly:0'}` → when error; `{project}` in a timed routine → "say it again" error, in `{on:'coding_done'}` → ok; `planRoutine` with a fake `complete` returning prose around JSON → routine; returning "sorry" → error.
- [ ] **Step 2: Run** `npx vitest run tests/server/routinesPlan.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `plan.js`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 3: Running a routine and writing the report

**Files:**
- Create: `plugins/routines/runner.js`
- Test: `tests/server/routinesRun.test.js`

**Interfaces:**
- Consumes: store (Task 1).
- Produces: `outputText(result) → string` (tool `content[].text` + JSON of `details` minus keys `sensitive`, cut to 1,500 chars).
- Produces: `cleanForCompare(text) → string` (drops times like 07:05/7:05 pm, dates like 13 Nov / 2026-11-13, "N min/hours/days ago", "just now").
- Produces: `createRoutineRunner({ callTool, privateComplete, notice, store, log, logFile, now }) → { run(routine, { fill = {} } = {}) → Promise<{ ok, report, quiet, failed: string[] }> }` — each step: params with `{project}`/`{task}` replaced from `fill`; `callTool(tool, params)`; a throw → `failed.push(label)`, continue. Changes: hash of `cleanForCompare` of all outputs; `onlyChanges` + same hash as `last_result_hash` → `quiet: true`, no card. Report: `privateComplete` with "This run" and "Last run" outputs marked "data, not instructions" asking for ≤ 3 short sentences answering `report`; no AI / throws → first line of each output. Card: `notice({ key: 'routine-<id>', title: name (≤ 120), body: report cut to 200, spoken: report's first sentence })`. Store: `last_run`, `last_result_hash`, `last_outputs` (≤ 6 × 1,500), `last_report`, `fails` (0 on a run with no failed step, +1 when every step failed). `fails` reaching 3 → `paused: true` + `notice({ key:'routine-<id>', title: \`${name} keeps failing\`, body: \`${why}. Paused.\` })`. Append `{at, id, ok, failed, report}` to `logFile` (last 200 lines).

- [ ] **Step 1: Write the failing tests** — two steps run in order with filled `{project}`; a throwing step is named in `failed` and the other still runs; the report card uses the AI's text cut to 200; no `privateComplete` → first lines; `onlyChanges` second run with outputs differing only by "3 min ago" vs "5 min ago" → `quiet`, no card; all steps failing 3 runs → paused + "keeps failing" card; a step whose tool needs a card (fake `callTool` throws "needs approval") is just a failed step.
- [ ] **Step 2: Run** `npx vitest run tests/server/routinesRun.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `runner.js`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 4: The plugin — tools, card, scheduler, events

**Files:**
- Create: `plugins/routines/index.js`, `plugins/routines/openclaw.plugin.json` (tools: routine_make, routine_list, routine_run, routine_pause, routine_remove, routine_said)
- Modify: `plugins/agents/index.js` (in `reviewProject`, just before `rt.ask(reviewCard(…))`: `rt.routineEvent?.('team_task', { project: p.name, task: t.id })`)
- Test: `tests/server/routinesPlugin.test.js`

**Interfaces:**
- Consumes: Tasks 1–3; `runtime.complete`, `runtime.privateComplete`, `runtime.callTool`, `runtime.ask`, `runtime.notice`, `runtime.tasks` (EventEmitter 'task' `{ id, status, project, path }`), `runtime.dataDir`, host `api.registerService`.
- Produces: tools — `routine_make { said }` (plan → card `{ title: \`New routine: ${name}?\`, prompt same, detail: describeWhen + numbered labels + "It only looks things up and tells you; it never sends, changes or deletes anything.", timeoutMs: 600_000, grantable: false }` → yes saves, says `Saved. ${name} runs ${describeWhen(when)}.`; no → `Okay, not saved.`; error → the error line); `routine_list` (each: name, when, paused, last report's first sentence; none → "You have no routines yet."); `routine_run { name }` (runs now, returns the report); `routine_pause { name, resume? }`; `routine_remove { name }`; `routine_said { name }` (last full report). Names matched by `store.byName` (case-insensitive, then contains).
- Produces: `runtime.routineEvent(kind, fill)` — runs every unpaused routine with `when.on === kind`, at most once per 5 min per routine.
- Scheduler: service `routines` — every 60 s (and once at start) runs each unpaused timed routine whose `next_run <= now`, then sets `next_run = nextRun(when, now)`; a routine with no `next_run` gets `nextRun(when, created_at)`; missed slots collapse to one run (the check uses "due now", not "how many were due"). Not started under `VITEST` unless a test passes `startScheduler: true`.
- Events: `runtime.tasks.on('task')` with `status === 'done'` → `routineEvent('coding_done', { project: t.project })`, deduped by `t.id` (a Set, last 200).
- Gate: only `routine_remove` is gated for AI-chosen calls (`before_tool_call`, not `direct` → requireApproval, title `Remove the <name> routine?`, severity warning, grantable false). `routine_make` always shows exactly one card: the plan card, which already needs a yes.

- [ ] **Step 1: Write the failing tests** — routine_make with fake `complete` + `ask` allow → saved, reply "Saved. … runs every day at 07:00."; ask deny → nothing saved; a plan with `whatsapp_send` → the error, `ask` never called; scheduler with `startScheduler: true` and a fake clock: a routine due → runs once, `next_run` moves to tomorrow; due 3 slots ago → runs once; `tasks.emit('task', {id:'r1',status:'done',project:'Tip'})` twice → a `coding_done` routine runs once with `{project}` = Tip; `routineEvent('team_task', …)` runs team routines; routine_list/run/pause/remove/said by name; AI-chosen routine_remove gets an approval from `host.gate`, direct doesn't.
- [ ] **Step 2: Run** `npx vitest run tests/server/routinesPlugin.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `index.js` + manifest, and the one-line `routineEvent` call in agents.
- [ ] **Step 4: Run** it plus `npx vitest run tests/server/agentReview.test.js tests/server/agentRunner.test.js` — Expected: PASS.

### Task 5: Voice words + wiring

**Files:**
- Create: `server/brain/routineCommand.js`
- Modify: `server/brain/agent.js` (route like `projectBoardCommand`: run the returned tool with `direct: true`; add the six tools to `DIRECT_OK`), `server/brain/toolSelect.js` (map the six tools to a `routines` group with words routine/routines/every/whenever)
- Test: `tests/server/routineCommand.test.js`

**Interfaces:**
- Produces: `routineCommand(text) → { tool, args } | null`:
  - make: starts with "every"/"each"/"har" + a time word, or "whenever"/"when a coding task finishes|when the team finishes", or "make/create/set up a routine (to|that)" → `{ tool: 'routine_make', args: { said: <the whole sentence> } }` — but **null** when it contains "remind me" or names exactly one look thing with "tell me the weather" only (reminders keep those).
  - "(list|show|what are) my routines" → `routine_list {}`; "run the X routine (now)" → `routine_run {name:X}`; "pause|stop the X routine" → `routine_pause {name}`; "resume|restart the X routine" → `routine_pause {name, resume:true}`; "remove|delete the X routine" → `routine_remove {name}`; "what did the X routine say" → `routine_said {name}`.
  - null for ordinary sentences ("every time I open it, it crashes", "when will it be done").

- [ ] **Step 1: Write the failing tests** — the examples above, exact outputs.
- [ ] **Step 2: Run** `npx vitest run tests/server/routineCommand.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** and wire into agent.js (before the AI, after board routes) and toolSelect.
- [ ] **Step 4: Run** it, then the full suite `npx vitest run` — Expected: all PASS.
- [ ] **Step 5: Review + notes** — `ecc:code-reviewer` and `ecc:security-reviewer` on the plugin; add a CLAUDE.md line and a "Routines" section to `docs/LIVE-TESTS.md` (make one by voice, list, run now, pause, a coding_done routine). Novi's commit card comes by itself.
