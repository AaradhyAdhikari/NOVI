# Claude Code + Antigravity: working together

A developer workflow for building Novi faster. Not part of Novi itself.

- **Claude Code** (Claude Pro) plans, designs, writes the tricky code, reviews everything.
- **Antigravity IDE** (free tier, Gemini Flash) does small, well-specified tasks so Claude's limits last longer.

## How a handoff works

1. Claude writes a task: `node tools/antigravity/handoff.js send --title "..." --files a.js,b.js --verify "npx vitest run tests/server/x.test.js" < instructions.md`
   This creates `.handoff/tasks/<id>.md` (self-contained: instructions, allowed files, rules) and prints a one-line prompt.
2. The prompt goes into the **Antigravity IDE → Agent panel** (Claude types it via screen control, or you paste it).
   `antigravity chat ...` from the command line does *not* work: it's VS Code's leftover command and never reaches the Agent panel.
3. Antigravity does the task and writes `.handoff/done/<id>.md` (`STATUS: done|blocked`, files, summary, verify output).
4. Claude waits with `node tools/antigravity/handoff.js wait <id>`, then reviews the diff and runs the full suite. Nothing is trusted unreviewed.

`node tools/antigravity/handoff.js list` shows every task and whether it's pending, done or blocked. `.handoff/` is gitignored.

## What goes to Antigravity

Good fits (small, clear, easy to check):
- Writing more test cases from a spec Claude already wrote, or fixtures and sample data.
- Boilerplate: a new plugin's skeleton copied from `plugins/clock`, simple CRUD, config wiring.
- UI polish: CSS, layout, icons, copy text, Settings-page fields.
- Docs: README sections, `docs/PLUGINS.md` examples, comments.
- Mechanical edits: renames across files, lint fixes, small refactors with tests already in place.
- Browser checks with Antigravity's built-in browser (does the page load, does the button show).

Stays with Claude:
- Specs, designs, plans, architecture, anything touching approvals, secrets, accounts or security.
- The brain/router, the agent loop, voice pipeline logic, tricky bugs.
- Final review of every Antigravity change, and the full test run.

## Rules every task carries
No commits or pushes (you commit with `Commit and Push.cmd`); never touch `.env`, `data/`, `NOVI CONTEXT.txt`; no new packages; stay inside the listed files; stop and report `blocked` instead of guessing.
