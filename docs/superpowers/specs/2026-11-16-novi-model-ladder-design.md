# Right model, right effort, even mid-task (design, 2026-11-16)

## Why
User: "if Opus is making UI design, motion and hard stuff but then a small box requires Haiku or Sonnet low
effort, it should use that rather than Opus high effort… we humans can't do that manually… it will save
thousands of tokens." Today Novi picks WHICH agent does a task, but a Claude run always uses one model and
effort for the whole run. The user chose both ways below (2026-11-16).

## Goals
- Every Claude run starts on the model + effort its work needs, and switches **inside the same session**
  when the work changes (no restart, nothing forgotten).
- Small parts inside a big piece go to a cheap helper by themselves.
- Learn from the user's answers which kinds of work need which level.

## Non-goals
- No new agents; OpenCode members already are one model each.
- No switching in the middle of one reply (only between pieces / via the helper).
- Never above what the plan allows: Opus high is the top; "max/xhigh" are not used automatically.

## Checked on the installed Claude Code (2026-11-16)
`--model <alias>` and `--effort low|medium|high|xhigh|max` at start; while running, stream-json control
requests `set_model` and `apply_flag_settings` (`effortLevel`) and `set_max_thinking_tokens`; `--agents <json>`
defines custom agents for the run (no files written into the user's projects).

## Approaches considered
1. Novi splits the job into pieces and switches model + effort between pieces in one session (Novi decides).
2. Claude hands small parts to a cheap helper agent by itself (Claude decides, finer grain).
3. One model per task, step up only on a redo — rejected by the user ("that's the thing we want to change").
**Chosen: 1 and 2 together.**

## Design
**The ladder** (`server/claude/modelLadder.js`): level → `{ model, effort }`: easy = haiku/low,
medium = sonnet/medium, hard = opus/high. `levelOf(text)` reuses `plugins/agents/roles.js` `levelFor`, nudged by
the track record (`record.js`: a level whose work keeps coming back steps one up for that kind of task).

**Way 1, pieces in one session**: after Claude's plan card is approved, its steps (`planSummary`) become the
pieces. Before each piece Novi sends `set_model` + `apply_flag_settings {effortLevel}` (only when they change)
and then the piece as the next message in the same session; the next piece starts when that turn ends. The run
starts with `--model`/`--effort` of the first piece. A piece whose turn fails, or any piece the user sends back,
is redone one step up. The card / board / activity line says which model did which piece.

**Way 2, the cheap helper**: every Novi-started Claude run gets `--agents` with `novi-quick` (model haiku,
effort low, tools Read/Edit/Write/Glob/Grep only, description "small, simple edits: text, colours, one small
component, a label") and the system prompt line "hand small, simple edits to the novi-quick agent".

**Where**: `server/claude/session.js` (`claudeArgs` + `setModel(model, effort)` sending the control requests),
`server/claude/taskManager.js` (piece runner after plan approval), `server/claude/modelLadder.js` (new),
agents runner passes the task's level to `startCoding`.

**Safety**: unchanged — permission cards, plan card, commit rules all stay; a model switch never changes what
Claude may do. A control request Claude Code rejects is logged and the piece goes on with the current model.

## Left to the builder
Exact control-request field names (verify against the binary/live), how pieces are worded, tests.
