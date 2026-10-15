# Novi Memory (wiki) — design

Date: 2026-10-15 · Status: approved in chat, spec awaiting review · Idea source: Dodaios "Wiki and
Memory" (github.com/Dodaios/Dodaios, Apache-2.0) and the JARVIS prompt pack (galaxy, fly-to-source).

## Goal

Novi remembers what she did and can answer from notes the user can read and edit in Obsidian.
User's choices (2026-10-15):

1. Notes folder: **Documents\Novi Memory** (visible, OneDrive-backed, opens as an Obsidian vault).
2. Written automatically: **only Novi's own actions log**.
3. Notes are used **only when the user asks** ("check my notes about X").
4. **Galaxy view in this first version** (Settings → Memory).
5. Long chats keep their earlier context (earlier ask: "all 4" memory goals).

Success = these work by voice on the laptop and phone:
"make a folder called test" → "rename it to demo" → "open the folder you just made" →
"what did you do today?"; "note that the DBMS exam is on 3 Nov" → "check my notes about DBMS"
answers with the source note; the galaxy shows the notes and their links.

## Out of scope (v1)

Automatic project pages, daily diary notes, people/topic pages, deleting notes, notes used on
every question, editing notes from Novi's UI (edit in Obsidian / Notepad).

## Parts

### A. Plugin host: `after_tool_call` hook (core, OpenClaw name)

`server/plugins/host.js` adds `after_tool_call` to SUPPORTED_HOOKS. The agent's `_runTool` fires
it after every tool run with `{ toolName, params, result, error, from }` (result = the tool's
output object; error = message when it failed). Handlers can't change anything; failures are
logged and ignored (same as `agent_end`).

### B. `plugins/wiki` — the vault

- Folder: `NOVI_MEMORY_DIR` or `<Documents>\Novi Memory`, where Documents is the first that exists
  of OneDrive\ドキュメント, OneDrive\Documents, Documents (same rule as `plugins/files`).
  Created on first write with `Novi Memory.md` (home page linking `Actions/` and `Notes/`).
- `Actions/YYYY-MM-DD.md`: one line per action (below).
- `Notes/<Title>.md`: user notes. Front matter `created`, `updated`, `source: novi|user`.
- Everything from this plugin is `sensitive: true` (private turns stay on Groq).
- Never written: text matching password / OTP / PIN / card-number / API-key patterns
  (`looksSecret`); Novi says she won't save secrets.

### C. Actions log (automatic)

`after_tool_call` handler records successful runs of: `file_new_folder`, `file_rename`,
`rename_project`, `file_open`, `open_project`, `file_gather`, `file_undo_move`,
`code_start_task`, `code_new_project`, `open_app`, `open_website`, `play_youtube`.
Line: `- 14:32 Made folder **test** — C:\Users\…\Desktop\test` (verb per tool, the name, the full
path or URL). Kept in memory too: the last 20 actions `{ at, tool, verb, name, path }`.

- `before_prompt_build` adds "Your recent actions (newest first): …" with the last 5 (one short
  line each, ~60 tokens) so "it / that / the folder you just made" resolve.
- Tool `wiki_recent { limit }` (read-only) returns the newest actions. Direct routes (no AI) live
  in the agent next to `fileCommand` (`memoryCommand`) and call it plus existing tools:
  - "what did you do today / what have you done / aaj kya kiya" → today's log read back, short
    (count + last 3, "and N more").
  - "open the folder/file you just made|opened|renamed" / "open it" (right after an action) →
    `file_open` with `path` of the newest matching action.
  - "rename it/that to X" → `file_rename` of the newest action's path (falls back to the current
    project when the newest action is a project).
  - "undo that" after a gather → `file_undo_move` (exists).

### D. New file tools (plugins/files)

- `file_open` gains an optional `path` (exact path; skips search).
- `file_rename { path, newName }`: renames a file or folder in place (Windows-safe name, keeps the
  extension of files, refuses if the target exists, EPERM/EBUSY → "Windows says it's in use").
  Direct-command rules: runs without a question when asked directly; asks once when the AI
  chooses it.

### E. Notes — only when asked

Tools (plugin `wiki`):
- `note_write { title?, text, append? }`: new note, or append to an existing one with the same
  title. Title = given, else the first 6 words. Mentions of existing note titles become
  `[[Title]]` links. Asks once when the AI chooses it; direct routes run without asking.
- `notes_ask { question }`: scores notes by word overlap (title words weigh 3×, fuzzy like the file
  index), takes the top 6, `runtime.privateComplete` with "answer ONLY from these notes, 2–3
  sentences, say so when they don't cover it", returns `{ answer, sources: [titles] }`; reply
  ends "From your notes: A, B." The page shows the source notes as a card.
- `note_open { title }`: opens the note in Obsidian (`obsidian://open?path=…`, when Obsidian is
  registered) else the default app.
- `notes_list`: titles + updated dates (read-only).

Direct routes: "note that …", "write a note (about X): …", "add to my X note: …",
"remember in my notes …" → `note_write`; "check my notes (about|for) X", "what do my notes say
about X", "notes mein X dekho" → `notes_ask`; "open my X note" → `note_open`.
The existing "remember …" facts (plugins/memory) are unchanged.

### F. Galaxy — Settings → Memory

- `GET /api/wiki/graph` (laptop + paired devices): `{ nodes: [{ id, title, folder, updated,
  excerpt }], links: [{ source, target }] }` from `[[links]]` and plain mentions of other titles.
  Actions files appear as one "Actions" cluster.
- `GET /api/wiki/note?id=` → the note's Markdown (shown as text, never as HTML).
- UI: `src/components/MemoryGalaxy.jsx` with `force-graph` (MIT, 2D canvas, lazy-loaded chunk).
  Dark space background, dots coloured by folder, size by link count, slow drift; click → zoom to
  the dot, highlight neighbours, side panel with the note; search box filters and flies to a
  match; list view for small screens. When `notes_ask` answers, the page flies to the top
  source note (JARVIS "fly-to-source") if Memory is open.

### G. Long chats

Agent history: when it passes 20 messages, the oldest 10 become one system line
"Earlier in this chat: …" (2 sentences, `privateComplete`, Groq only). On failure, they're just
dropped as today.

## Errors

- Vault folder can't be created → actions are still kept in memory; Settings → Memory says why.
- `notes_ask` with no matching notes → "Your notes don't mention X."
- Groq busy on `notes_ask` → the usual "busy, try again" (notes never go to another provider).

## Testing (TDD, Vitest)

host hook fires with result/error · action lines and recent list per tool · recent-actions prompt
line · direct routes (it/that, what did you do today) · file_rename (folder, file keeps extension,
exists, EPERM) · file_open path · note_write (new, append, auto-links, secrets refused) ·
notes_ask (top-6 scoring, sources, no-match) · graph API (links, excerpts, private) · history
summary at 20 · UI galaxy component renders nodes from the API (smoke).
Live check on the laptop: the success list above.
