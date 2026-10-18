# Novi's second brain (Part 1 of 3)

Date: 2026-10-18 · Status: approved in chat ("Yes, write the spec and build Part 1"; engine = local model,
scope = everything readable).

## What the user wants
"Sync my whole computer to Novi… all the project files, all the folders… make it my second brain", "make
everything simple and easily accessible", and the design rule they brought: **never send all memory to the
AI — search the brain, take the evidence the request needs, and only then build the AI's context.**

## The three parts
1. **(this spec)** One brain store (SQLite) for projects, folders, files, notes and how they connect;
   keyword search inside every readable file; a per-request context builder; simple project dots; an AI-keys
   check.
2. Meaning search (local multilingual-e5-small, ~120 MB, nothing leaves the laptop), the retrieval test
   suite (accuracy, latency, stale memory, cross-project leaks), files to the phone.
3. Nightly tidy-up (summaries of old chats, merged duplicates, superseded facts) and a daily "what changed" note.

## Part 1

### Store — `plugins/brain/store.js`
`node:sqlite` (built into Node ≥ 22.5; nothing to install) at `data/brain/brain.db`.
- `items(id, kind, title, path, url, project, mtime, size)` — kind = project | folder | file | note.
- `links(a, b, rel)` — project→folder, project→file (inside its folder), project→note ("X brief", "X …").
- `chunks(item_id, n, text)` + FTS5 table over (title, path, text), `unicode61 remove_diacritics 2`.
- `store.upsert(item, chunks?)`, `store.remove(id)`, `store.link(a, b, rel)`, `store.stats()`.
- No `node:sqlite` (old Node) → the plugin says "Update Node to 22.5 or newer for the second brain" once
  and stays off; nothing else breaks.

### Filling it — `plugins/brain/ingest.js`
- **Names of everything**: the files plugin's index (`runtime.fileEntries()`, already every drive, every
  15 min) → file/folder items (title = file name).
- **Inside every readable file** (user: "everything readable"): `readFileText` from the files plugin
  (text, code, Word, Excel, PowerPoint, PDF), cut into ~800-character chunks, at most 60k characters a file.
  Only files whose mtime changed are read again. Runs in the background, a few files at a time, never
  blocking a request; resumes after a restart.
- **Never read**: `.env*`, keys/certificates (`.pem .key .pfx .p12 .kdbx`), names with
  password/secret/credential/token/otp, files over 5 MB, Novi's own `data/` folder, and any text that
  `looksSecret` (the wiki rule). Their names are still known.
- **Projects**: `runtime.projects.list()` (+ claude.ai links from claude-link) → project items, linked to
  their folder and every file inside it, and to notes named after them.
- **Notes**: every Novi Memory note (wiki vault) → note items with their text.

### Search — `plugins/brain/search.js`
`search(query, { project, limit = 6 })` → `[{ id, kind, title, path, project, snippet, score }]`:
FTS5 bm25 over chunks + exact-name boost (title equals / starts with a query word) + recency. With a
`project`, only that project's items (no cross-project leak). Plain words only (FTS syntax escaped).

### Context builder (the design rule) — `before_prompt_build` hook
For each AI turn: search with the user's words (current coding project if one is active), keep passages
whose score passes a floor, at most **6 passages / 1,500 characters**, each with its source
("From TraceBite/README.md: …"), and mark the turn `sensitive` (stays on Groq). Nothing found → nothing
added. The AI never gets the whole brain.

### Tools
- `brain_search { query, project? }` — what the brain has (titles, paths, short snippets), read-only.
- `brain_status` — items / files read / last scan / "still reading N files".

### Simple project dots (user: "why so many different icons")
`projectFiles` → at most 3 dots per project besides its notes: **Context** (the README), **Pictures**
(one dot; the excerpt lists the distinct pictures — `icon-32.png`, `icon-192.png`… count as one
`icon.png`), **Files** (the folder, with its file count).

### AI-keys check (user: "make Novi not stall")
Settings → System lists every AI provider with its number of keys (never the values) and which free ones
have none. Voice "which AI keys are missing" answers the same without the AI.

## Not in Part 1
Meaning search, the retrieval test suite, files to the phone, nightly tidy-up, "what changed" note, facts and
tasks from the long-term memory plugin (Part 2/3).

## Testing
Store, ingest (skips, chunks, mtime re-read, project links), search (boosts, project filter, escaping),
context builder (cap, sources, sensitive, empty), project dots (icon sizes → one), keys check.
