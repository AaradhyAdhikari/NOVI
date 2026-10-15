# Novi Memory (wiki) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Novi keeps a Markdown actions log + user notes in `Documents\Novi Memory`, resolves "it / the folder you just made", answers "check my notes about X" with sources, and shows the notes as a galaxy in Settings → Memory.

**Architecture:** One new plugin `plugins/wiki` (vault, actions log via a new `after_tool_call` host hook, note tools, graph data); small additions to `plugins/files` (`file_rename`, `file_open { path }`); direct voice routes in `server/brain/agent.js` (`memoryCommand`); history summary in the agent; two read-only HTTP routes and a lazy-loaded React galaxy.

**Tech Stack:** Node ESM, Vitest, React/Vite, `force-graph` (MIT) for the galaxy.

**Spec:** `docs/superpowers/specs/2026-10-15-novi-wiki-memory-design.md`

## Global Constraints

- Vault = `NOVI_MEMORY_DIR` or `<Documents>\Novi Memory`; Documents = first existing of `OneDrive\ドキュメント`, `OneDrive\Documents`, `Documents` under home.
- Files: `Novi Memory.md`, `Actions/YYYY-MM-DD.md`, `Notes/<Title>.md` (front matter `created`, `updated`, `source: novi|user`).
- Everything the wiki plugin returns sets `sensitive: true`; `notes_ask` uses `runtime.privateComplete` only.
- Never write text that `looksSecret` (password / OTP / PIN / card number / API key).
- Recent actions in the prompt: last 5, one line each. In-memory recent list: last 20.
- History summary threshold: more than 20 messages → oldest 10 become one "Earlier in this chat: …" system line.
- `notes_ask`: top 6 notes, title words weigh 3×, answer "ONLY from these notes, 2–3 sentences", reply ends "From your notes: A, B."
- Direct voice commands run without a question (`DIRECT_OK`); the AI choosing `note_write` / `file_rename` asks once. No note deletion in v1.
- Work on branch `claude/ecstatic-brahmagupta-0bsazo`; run `TZ=Asia/Kolkata npx vitest run` (2 known cloud env failures: app.test VAD files, workspaceTools timeout).

## Review Focus

- A title / folder name with Windows-illegal characters (`a/b:c?`) must be cleaned, never written as-is → test in Task 2 (`file_rename`) and Task 4 (`note_write`).
- "rename it" when there is no recent action → falls back to the current project, else asks "Rename what?" (never renames something random) → test in Task 5.
- A note whose text contains a password-like string is refused with a spoken reason, nothing written → test in Task 4.
- The vault folder can't be created (read-only / OneDrive missing) → actions still go to the in-memory recent list and the tool run is not broken → test in Task 3.
- The graph API must never render note text as HTML (a note containing `<script>`) → returned as plain text, UI shows it in `<pre>` → test in Task 7.

---

### Task 1: `after_tool_call` hook

**Files:**
- Modify: `server/plugins/host.js` (SUPPORTED_HOOKS; new `afterToolCall(event)` next to `agentEnd`)
- Modify: `server/brain/agent.js` (`_runTool` fires it)
- Test: `tests/server/pluginHost.test.js`, `tests/server/agent.test.js`

**Interfaces:**
- Produces: plugins may `api.on('after_tool_call', ({ toolName, params, result, error }) => …)`; host method `afterToolCall(event): Promise<void>` (handler errors logged as `Plugin "<id>" after_tool_call hook failed: …`, never thrown). Agent calls `this.tools.afterToolCall?.({ toolName, params, result: output, error: output?.error })` after every run (not awaited).

- [ ] Step 1: tests — host calls a registered `after_tool_call` handler with the event; a throwing handler doesn't throw; agent `_runTool` of a low tool triggers `afterToolCall` with `toolName` and `result` (fake `tools.afterToolCall` spy).
- [ ] Step 2: run → fail.
- [ ] Step 3: implement.
- [ ] Step 4: run → pass.
- [ ] Step 5: commit `Plugin host: after_tool_call hook`.

### Task 2: `file_rename` and `file_open { path }`

**Files:**
- Modify: `plugins/files/index.js`, `plugins/files/openclaw.plugin.json` (tools list)
- Modify: `server/brain/agent.js` (`DIRECT_OK` adds `file_rename`)
- Test: `tests/server/filesPlugin.test.js`

**Interfaces:**
- Produces: `file_rename { path: string, newName: string }` → `{ renamed: newPath, note: "Renamed it to <name>." }`; files keep their extension when `newName` has none; name cleaned with `safeName`; target exists → note "There's already something called X there."; EPERM/EBUSY/EACCES → note "Windows says X is in use. Close any window using it, then ask me again."; missing path → note "I can't find that anymore." Approval (`before_tool_call`): title `Rename <old> to <new>`, prompt same + ".", category `files`.
- `file_open { query?, path? }`: `path` given and exists → open it directly.

- [ ] Step 1: tests — rename folder; rename file `notes.txt` → `todo` gives `todo.txt`; `a/b:c?` → `abc`; exists; missing; `file_open({ path })` opens exactly that path.
- [ ] Step 2: run → fail. Step 3: implement. Step 4: run → pass.
- [ ] Step 5: commit `Files: rename any file or folder; open by exact path`.

### Task 3: `plugins/wiki` — vault + actions log

**Files:**
- Create: `plugins/wiki/vault.js`, `plugins/wiki/actions.js`, `plugins/wiki/index.js`, `plugins/wiki/openclaw.plugin.json`
- Test: `tests/server/wikiActions.test.js`

**Interfaces:**
- `vault.js`: `memoryDir({ env, home, exists })` → path; `createVault(dir)` → `{ ensure(), write(rel, text), append(rel, text), read(rel), list(sub) → [{ rel, title, mtime }] }`; `looksSecret(text): boolean`; `safeTitle(s)`.
- `actions.js`: `describeAction(toolName, params, result) → { verb, name, path } | null` for the 12 tools in the spec (null for others / failures); `createActionLog({ vault, now })` → `{ record(event), recent(n) → [{ at, tool, verb, name, path }], today() → lines }`. Line format: `- HH:MM <Verb> **<name>** — <path>`.
- `index.js`: `createWikiPlugin({ home, env, now })` registers `after_tool_call` → `record`, `before_prompt_build` → `{ appendSystemContext: "Your recent actions (newest first): …" }` (last 5; nothing when empty), tool `wiki_recent { limit }` → `{ actions, sensitive: true }`.

- [ ] Step 1: tests — `file_new_folder` result `{ created }` → line "Made folder **test** — <path>" in `Actions/<today>.md`; `rename_project`/`file_rename` → "Renamed … to …"; failed run (error) → nothing; recent(5) newest first; prompt line lists 5; vault dir unwritable (dir = a file path) → `record` still fills `recent`, no throw; `looksSecret('my password is hunter2')` true, `looksSecret('DBMS exam 3 Nov')` false; `memoryDir` picks `OneDrive/ドキュメント/Novi Memory` when that exists.
- [ ] Step 2: run → fail. Step 3: implement. Step 4: run → pass.
- [ ] Step 5: commit `Wiki plugin: Novi Memory vault and actions log`.

### Task 4: notes — write, ask, open, list

**Files:**
- Create: `plugins/wiki/notes.js`
- Modify: `plugins/wiki/index.js`, `plugins/wiki/openclaw.plugin.json`
- Modify: `server/brain/toolSelect.js` (group words `note notes noted` → `wiki`; `GROUP` maps `note_*`, `notes_*`, `wiki_*` to `wiki`)
- Test: `tests/server/wikiNotes.test.js`

**Interfaces:**
- `notes.js`: `createNotes({ vault, now })` → `{ write({ title?, text, append? }) → { title, created: boolean }, search(question, k=6) → [{ title, text, score }], titles() }`; auto-link: other note titles appearing in the text become `[[Title]]`; `title` default = first 6 words of text.
- Tools: `note_write` (approval when AI-chosen: title `Write note <title>`, category `notes`), `notes_ask { question }` → `{ answer, sources, sensitive }` via `api.runtime.privateComplete`, `note_open { title }` (`obsidian://open?path=<encoded abs path>` through the files opener when Obsidian is registered, else the file), `notes_list`.

- [ ] Step 1: tests — new note file with front matter; same title appends; "DBMS" mention links `[[DBMS plan]]`; secret text refused with note "I won't save passwords or codes in notes." and no file; `a/b:c?` title cleaned; `search` ranks a title match above a body match; `notes_ask` sends ≤6 notes to `privateComplete` and the reply ends "From your notes: …"; no matches → "Your notes don't mention X."
- [ ] Step 2: run → fail. Step 3: implement. Step 4: run → pass.
- [ ] Step 5: commit `Wiki: notes you can write, ask and open`.

### Task 5: voice routes — `memoryCommand`

**Files:**
- Modify: `server/brain/agent.js` (`memoryCommand(text, recent)` export; called in `handle` and `firstStep` before `fileCommand`; `DIRECT_OK` adds `note_write`, `notes_ask`, `note_open`, `file_rename`)
- Test: `tests/server/agent.test.js`

**Interfaces:**
- Consumes: `wiki_recent` (Task 3), `file_open { path }`, `file_rename` (Task 2), note tools (Task 4).
- Produces: `memoryCommand(text, recent) → { tool, args } | { reply } | null`:
  - "what did you do (today)" / "what have you done" / "aaj kya kiya" → `{ reply }` built from recent: "Today I did N things. Last: A, B, C." (none → "Nothing yet today.")
  - "open the folder/file you just made|opened|renamed" / "open it" → `file_open { path }` of the newest matching action.
  - "rename it/that to X" → `file_rename { path, newName }` of the newest action with a path; newest is a project → `rename_project`; no action → `{ reply: 'Rename what? Tell me the name.' }`.
  - "note that X" / "write a note (about T): X" / "add to my T note: X" / "remember in my notes X" → `note_write`.
  - "check my notes (about|for) X" / "what do my notes say about X" / "notes mein X dekho" → `notes_ask`.
  - "open my X note" → `note_open`.

- [ ] Step 1: tests for each phrase above incl. lead/tail words ("okay … right now"), the no-action fallback, and that "rename sample project to calc" still goes to `renameCommand` (not this).
- [ ] Step 2: run → fail. Step 3: implement. Step 4: run → pass.
- [ ] Step 5: commit `Voice: "rename it", "what did you do today", notes by voice`.

### Task 6: long chats keep earlier context

**Files:**
- Modify: `server/brain/agent.js` (`_remember`; optional `summarize` dep = `runtime.privateComplete`)
- Test: `tests/server/agent.test.js`

**Interfaces:**
- Agent option `summarize(text): Promise<string>`. When `history.length > 20`: oldest 10 messages → `summarize("Summarize in 2 sentences what was said: …")` → replaced by `{ role: 'system', content: 'Earlier in this chat: <summary>' }`; summarize throws → those 10 are dropped. Runs after the reply (never delays it).

- [ ] Step 1: tests — 22 messages → first entry is the summary line and length is 13; failing summarize → length 12, no throw.
- [ ] Step 2: run → fail. Step 3: implement; pass `summarize` from `server/app.js`. Step 4: run → pass.
- [ ] Step 5: commit `Long chats: summarize older messages`.

### Task 7: graph API + Settings → Memory galaxy

**Files:**
- Create: `plugins/wiki/graph.js`, `src/components/MemoryGalaxy.jsx`
- Modify: `server/app.js` (`GET /api/wiki/graph`, `GET /api/wiki/note?id=`; read-only, importing `memoryDir`/`createVault` from `plugins/wiki/vault.js` and `buildGraph` from `plugins/wiki/graph.js`), `src/components/SettingsDrawer.jsx` (section "Memory"), `package.json` (`force-graph` exact version)
- Test: `tests/server/wikiGraph.test.js`

**Interfaces:**
- `graph.js`: `buildGraph(vault) → { nodes: [{ id, title, folder, updated, excerpt (≤200 chars) }], links: [{ source, target }] }` from `[[links]]` and plain title mentions; all `Actions/*` collapse into one node `Actions`.
- `/api/wiki/note?id=<rel>` → `{ title, text }` (plain text; id must stay inside the vault, `..` → 400).
- UI: lazy `import('force-graph')`; dark background; colour by folder; size by link count; click → `centerAt` + `zoom`, neighbours highlighted, side panel shows text in `<pre>`; search box flies to the first title match; < 600 px wide → list view.

- [ ] Step 1: tests — links from `[[ ]]` and mentions; Actions collapsed; excerpt ≤200; `id=../.env` → 400; note text with `<script>` returned verbatim as JSON text.
- [ ] Step 2: run → fail. Step 3: implement server + UI; `npm run build` succeeds. Step 4: run → pass.
- [ ] Step 5: commit `Settings → Memory: notes galaxy`.

### Task 8: wrap-up

- [ ] Full suite `TZ=Asia/Kolkata npx vitest run` → only the 2 known env failures.
- [ ] `tools/my-commands.json`: add "rename it to demo", "what did you do today", "note that …", "check my notes about DBMS".
- [ ] CLAUDE.md note; push; draft PR; subscribe.
