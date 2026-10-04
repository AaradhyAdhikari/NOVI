# NOVI — Reminders & Timers Plugin — Design Spec

Date: 2026-10-04
Status: **Approved by the user** (2026-10-04) — next step: write the plan, then build with TDD.

## Behaviour

| User says | Result |
|---|---|
| "Remind me at 6 pm to call mom" · "remind me tomorrow at 9 to submit the form" · "in 20 minutes remind me to check the oven" | Saved; Novi confirms the resolved time ("Okay, at 6:00 pm today: call mom.") |
| "Set a 10-minute timer" · "timer for 25 minutes called study" | Countdown reminder |
| "Remind me every day at 8 am to drink water" · "every weekday at 9 …" | Repeats `daily` / `weekdays` |
| "What are my reminders?" | Upcoming ones, soonest first |
| "Cancel the oven reminder" | Removed, no approval |
| "Cancel all reminders" | Needs an Allow card (`warning`) |

- When due: spoken on every connected device ("Reminder: call mom") **and** added to the chat transcript.
- Survives restarts: stored in `data/reminders.json`. Reminders that came due while Novi was off are announced as **missed** at startup; repeating ones then reschedule to their next occurrence.

## Plugin `plugins/reminders` (OpenClaw shape)
- Tools: `reminder_add { text, when, repeat? }`, `timer_set { minutes, label? }`, `reminder_list`, `reminder_cancel { id? , match? , all? }`.
- Approval: only `reminder_cancel` with `all: true` (`severity: 'warning'`).
- **Time parsing in the plugin** (not left to the LLM): "in N minutes/hours", "at 6", "6:30 pm", "18:00", "tomorrow at 9", "Monday at 5", "today at …", ISO date/time. Ambiguous past times roll to the next occurrence and the reply says so ("6:00 am tomorrow"). Unparseable → the tool returns an error asking the user to rephrase. Uses the laptop's local timezone; parser takes an injectable `now` for tests.
- Scheduler: one `setTimeout` per pending reminder (re-armed in chunks for far-future times, since `setTimeout` caps at ~24.8 days); clears timers on cancel.

## Core additions (small, exposed via `api.runtime`)
- `runtime.dataDir` — folder for plugin data files.
- `runtime.say(text)` — adds a Novi chat entry and speaks it (today `runtime.speak` only speaks).
- Host lifecycle: plugins may export `start()`/`stop()` via `api.registerService({ start, stop })` (OpenClaw has plugin services) so the scheduler starts after load and stops on shutdown.

## Tests
- Parser table with a fixed `now` (incl. past-time rollover, month/year boundaries, 12 am/pm, weekdays, invalid input).
- Scheduling and firing with fake timers; missed-at-startup; repeat rescheduling; cancel one/all; persistence across instances.
- Plugin: tools via `PluginHost`, approval only for cancel-all.
- Live: a 1-minute timer heard on the laptop.
