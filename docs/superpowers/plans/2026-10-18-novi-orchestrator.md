# Orchestrator Implementation Plan

> Executed inline (user: "YES BUILD IT"), TDD per task.

**Goal:** big coding jobs get a brief from the ChatGPT and Gemini websites before Claude starts.
**Spec:** `docs/superpowers/specs/2026-10-18-novi-orchestrator-design.md`

## Tasks
1. **Extension 1.2.0** — `page.js` `textOf({ selector })` → `{ count, text }` (last visible match, `innerText`
   with line breaks, ≤ 20,000 chars); `background.js` routes `textOf`, `open` with `tabId` navigates that tab.
   Test: `browserExtension.test.js`.
2. **Shared services** — browser plugin sets `runtime.browserRequest`; wiki plugin sets
   `runtime.wikiWrite({ title, text })` (refuses secrets) / `runtime.wikiRead(title)`.
   Tests: `browserPlugin.test.js`, `wikiPlugin.test.js`.
3. **Changeable approvals** — `decide({ changeable })`, `resolve(..., { change })` → `{ allow: false, change }`.
   Test: `permissions.test.js`.
4. **Site driver** — `plugins/orchestrator/sites.json` + `siteDriver.js` `createSiteDriver({ request, sleep, now, log })`
   → `ask(site, prompt)` / `followUp(site, text)` → `{ text }` | `{ error, login? }`. Test: `orchestratorSites.test.js`.
5. **Context, prompts, brief** — `context.js` `gatherFacts(path, { note })`, `prompts.js` `planPrompt` /
   `ideasPrompt` / `changePrompt`, `brief.js` `sections` / `buildBrief`. Test: `orchestratorBrief.test.js`.
6. **Plugin** — `plugins/orchestrator/index.js` tool `project_brief { project?, name?, request, isNew? }`:
   note at once, background job (facts → both sites → backups → brief → note → `runtime.ask` →
   start / change loop / no). Test: `orchestratorPlugin.test.js`.
7. **Runtime + card** — `runtime.ask/startCoding/newProject/complete` in `app.js`; card fold label
   "Show the full brief" for `source: 'orchestrator'`. Test: `app.test.js`.
8. **Voice** — `server/brain/briefCommand.js` `briefCommand(text)`; agent `changeCommand` + brief route
   after `_projectCommand`. Tests: `briefCommand.test.js`, `agent.test.js`.
9. CLAUDE.md, full suite, commit, PR.
