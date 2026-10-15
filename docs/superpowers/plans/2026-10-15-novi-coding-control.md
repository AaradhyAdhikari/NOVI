# Novi Coding Control v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code's own questions are asked and answered by voice through Novi, and "show me the homepage" sends a phone-sized picture plus a protected live link of the project's running site.

**Architecture:** Claude's `AskUserQuestion` arrives on the existing stdio permission channel (`server/claude/session.js`); TaskManager turns each question into a new kind of approval (`question`, no timeout) that the agent resolves from spoken words with pure matching rules (`server/claude/questions.js`). A new `plugins/preview` finds how to run a project without AI, runs it as a child process, takes a picture with the existing hidden-Edge page shot, and serves the live site on its own HTTPS port behind a one-time token.

**Tech Stack:** Node ESM, Vitest, node:http/https/net (no new npm dependencies), React UI, existing `ApprovalQueue`, `TaskManager`, `PluginHost` runtime.

**Spec:** `docs/superpowers/specs/2026-10-15-novi-coding-control-design.md`

## Global Constraints

- Never run the real `claude` CLI in tests; use `tests/fixtures/fake-claude.mjs`.
- No AI (free brain or Claude) for matching answers or for finding how to run a site.
- A question nobody answers waits with no timeout; one spoken reminder after 5 minutes: `Claude is still waiting: <question>?`
- Spoken question: `Claude asks: <question>? One, <label>. Two, <label>. …` (at most 4 options spoken).
- Preview port: `NOVI_PREVIEW_PORT`, default `3005`; token valid 30 minutes, one project; requests without a valid token/cookie → 403.
- Picture size for phones: 390×844.
- Starting a project's command asks once per project per Novi run: `Start the <project> site to preview it?`, category `preview`, grantable. Static serving and pictures never ask.
- No new npm dependencies. Every feature is a plugin except shared services exposed through `api.runtime`.
- Full suite: `TZ=Asia/Kolkata npx vitest run` → only the 2 known env failures (app.test VAD files, workspaceTools timeout).

## Review Focus

1. A yes/no approval and a Claude question waiting at the same time: "yes" answers the yes/no card, "dark" / "doosra" answers the question — pinned in Task 4.
2. The dev server crashes or is stopped after the first preview: the next "show me the homepage" starts it again instead of a dead link — pinned in Task 7.
3. Vite moves to another port because the usual one is busy: the port printed in the output wins over `run.json` — pinned in Task 7.
4. A preview link opened after 30 minutes, or a token for project A used against project B: refused — pinned in Task 8.
5. Novi stops or restarts: no orphan dev servers keep running — pinned in Task 9 (service stop calls `stopAll`).

---

### Task 1: Question helpers (spoken text + answer matching)

**Files:**
- Create: `server/claude/questions.js`
- Test: `tests/server/claudeQuestions.test.js`

**Interfaces:**
- Produces: `spokenQuestion(q: { question, options: [{label}] }) => string`; `matchAnswer(text: string, options: [{label}], { multiSelect = false } = {}) => { kind: 'option', labels: string[] } | { kind: 'skip' } | { kind: 'own', text: string }`; `answerFor(match) => string` (labels joined by ", ", own text as is, skip → `''`).

- [ ] **Step 1: Write the failing tests**

```js
const opts = [{ label: 'Dark' }, { label: 'Light' }, { label: 'Ocean blue' }];
expect(spokenQuestion({ question: 'Which color theme?', options: opts })).toBe('Claude asks: Which color theme? One, Dark. Two, Light. Three, Ocean blue.');
expect(spokenQuestion({ question: 'Pick one', options: [1,2,3,4,5].map((n) => ({ label: `L${n}` })) })).toBe('Claude asks: Pick one? One, L1. Two, L2. Three, L3. Four, L4.');
for (const [t, want] of [['one', 'Dark'], ['the first one', 'Dark'], ['2', 'Light'], ['doosra', 'Light'], ['teesra wala', 'Ocean blue'], ['pehla', 'Dark'], ['last one', 'Ocean blue'], ['dark', 'Dark'], ['blue', 'Ocean blue'], ['Light please', 'Light']])
  expect(matchAnswer(t, opts), t).toEqual({ kind: 'option', labels: [want] });
expect(matchAnswer('make it purple', opts)).toEqual({ kind: 'own', text: 'make it purple' });
expect(matchAnswer('skip', opts)).toEqual({ kind: 'skip' });
expect(matchAnswer('one and three', opts, { multiSelect: true })).toEqual({ kind: 'option', labels: ['Dark', 'Ocean blue'] });
expect(matchAnswer('dark aur light', opts, { multiSelect: true })).toEqual({ kind: 'option', labels: ['Dark', 'Light'] });
expect(answerFor({ kind: 'option', labels: ['Dark', 'Light'] })).toBe('Dark, Light');
```

- [ ] **Step 2: Run** `npx vitest run tests/server/claudeQuestions.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `server/claude/questions.js`. Number words: en (one/first/1 … four/fourth/4, last), hi (ek/pehla/pehli, do/doosra/doosri, teen/teesra/teesri, char/chautha, aakhri), mr (pahila, dusra, tisra); filler words `the|one|option|wala|vala|wali|please|number`. Label match: whole label, else a word of the label (≥3 letters) that belongs to only one option. Skip words: `skip|cancel|chhodo|rehne do|koi bhi nahi`. Whole-utterance only (strip punctuation, lowercase).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Claude questions: spoken text and voice answer matching"`

### Task 2: Question approvals in the queue

**Files:**
- Modify: `server/permissions.js` (`ApprovalQueue.decide`, `resolve`)
- Test: `tests/server/permissions.test.js` (append)

**Interfaces:**
- Produces: `decide({ …, question?: { text, options, multiSelect }, timeoutMs?: number|null })` — approval object gets `question`; `timeoutMs: null` = no timer. `resolve(id, allow, by, choice, { …, answer?: string })` → decision `{ allow, choice, answer? }` (answer only when `allow` and the approval has `question`). New `waitingQuestion()` → latest pending approval with `question` or null. `latest()` skips question approvals (so a spoken "yes" never answers a question).

- [ ] **Step 1: Write the failing tests**

```js
it('question approvals: no timeout, answer passed through, never picked by latest()', async () => {
  vi.useFakeTimers();
  const q = new ApprovalQueue({ timeoutMs: 1000 });
  const p = q.decide({ title: 'Claude asks: Theme?', tier: 'medium', source: 'claude', question: { text: 'Theme?', options: [{ label: 'Dark' }] }, timeoutMs: null });
  vi.advanceTimersByTime(10 * 60_000);
  expect(q.pending()).toHaveLength(1);
  expect(q.latest()).toBe(null);
  expect(q.waitingQuestion().question.text).toBe('Theme?');
  q.resolve(q.pending()[0].id, true, 'voice', null, { answer: 'Dark' });
  expect(await p).toEqual({ allow: true, choice: null, answer: 'Dark' });
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/permissions.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the fields above in `server/permissions.js` (question approvals are never grantable).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Approvals: question kind with no timeout and a spoken answer"`

### Task 3: TaskManager asks Claude's questions

**Files:**
- Modify: `server/claude/session.js` (`_answerPermission` uses `decision.updatedInput` when given), `server/claude/taskManager.js` (`_onPermission`, `stop`)
- Modify: `tests/fixtures/fake-claude.mjs` (prompt containing `ASK` → `ask('AskUserQuestion', { questions: [{ question: 'Which color theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }, { question: 'Add a contact form?', options: [{ label: 'Yes' }, { label: 'No' }] }] })`; result text = `Answers: ${JSON.stringify(decision.updatedInput?.answers)}`)
- Test: `tests/server/claudeQuestionsTask.test.js`

**Interfaces:**
- Consumes: Task 1 `spokenQuestion`, `answerFor`; Task 2 `decide({ question, timeoutMs: null })`.
- Produces: `onPermission` may return `{ allow: true, updatedInput }`; TaskManager emits `speak` with `Claude is still waiting: <question>?` once after `questionReminderMs` (constructor option, default `5 * 60_000`).

- [ ] **Step 1: Write the failing tests** (fake Claude, real ApprovalQueue):

```js
it('asks each question in turn and sends the answers back', async () => { /* start task 'ASK', approvals.on('added') resolve first with { answer: 'Dark' }, second with { answer: 'No' } */
  expect(asked.map((a) => a.question.text)).toEqual(['Which color theme?', 'Add a contact form?']);
  expect(asked[0].title).toBe('Claude asks: Which color theme?');
  expect(finalResult).toBe('Answers: {"Which color theme?":"Dark","Add a contact form?":"No"}');
});
it('a skipped question tells Claude to choose', async () => {
  // approvals.resolve(first.id, false) → finalResult contains '"Which color theme?":"The user skipped this question; choose sensibly and say what you chose."'
});
it('reminds once after 5 minutes', async () => {
  // new TaskManager({ …, questionReminderMs: 50 }); after 60 ms spoken === ['Claude is still waiting: Which color theme?']; after 250 ms still length 1
});
it('stopping the task skips the open question', async () => {
  // await tasks.stop(); expect(approvals.pending()).toEqual([])
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/claudeQuestionsTask.test.js` — Expected: FAIL (questions become permission cards).
- [ ] **Step 3: Implement**: in `_onPermission`, `toolName === 'AskUserQuestion'` → loop `input.questions`, `await this.approvals.decide({ title: \`Claude asks: ${q.question}\`, tier: 'medium', source: 'claude', prompt: spokenQuestion(q), question: { text: q.question, options: q.options, multiSelect: Boolean(q.multiSelect) }, timeoutMs: null })` with the reminder timer cleared on answer; return `{ allow: true, updatedInput: { ...input, answers } }`. `stop()` calls `this.approvals.denyWhere((a) => a.question)` before stopping.
- [ ] **Step 4: Run** — Expected: PASS; also `npx vitest run tests/server/taskManager.test.js tests/server/claudeSession.test.js` stay green.
- [ ] **Step 5: Commit** `git commit -m "Claude questions go to Novi as question cards, answers go back to Claude"`

### Task 4: Answering by voice

**Files:**
- Modify: `server/brain/agent.js` (`handle`: before `alsoCommand`), `server/brain/answers.js` (`spokenApproval` returns `approval.prompt` for question approvals)
- Test: `tests/server/agent.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `matchAnswer`, `answerFor`; Task 2 `waitingQuestion()`, `resolve(…, { answer })`.
- Produces: replies `Okay, I told Claude: <answer>.` / skip → `Okay, Claude will choose.`

- [ ] **Step 1: Write the failing tests**

```js
it('while Claude asks, "doosra" / "dark" / own words answer it; yes/no cards keep "yes"', async () => {
  // a pending yes/no approval (tier medium) AND a pending question approval (options Dark, Light)
  expect(await agent.handle('doosra')).toBe('Okay, I told Claude: Light.');
  // new question pending again + a yes/no card:
  await agent.handle('yes');
  expect(approvals.pending().some((a) => !a.question)).toBe(false);   // the yes/no card got the "yes"
  expect(approvals.waitingQuestion()).not.toBe(null);                 // the question still waits
  expect(await agent.handle('make it purple')).toBe('Okay, I told Claude: make it purple.');
});
```

- [ ] **Step 2: Run** `npx vitest run tests/server/agent.test.js -t "Claude asks"` — Expected: FAIL.
- [ ] **Step 3: Implement**: at the top of `handle`, `const q = this.approvals.waitingQuestion?.()`; if `q` and the words are not a plain yes/no answer while a yes/no card also waits (`answerKind(text)` with `this.approvals.latest()`), resolve `q` with `matchAnswer(text, q.question.options, { multiSelect: q.question.multiSelect })` (skip → `resolve(id, false)`), return the reply.
- [ ] **Step 4: Run** — Expected: PASS; full `tests/server/agent.test.js` green.
- [ ] **Step 5: Commit** `git commit -m "Answer Claude's questions by voice"`

### Task 5: Question cards on the screen

**Files:**
- Modify: `src/components/ApprovalCards.jsx`, `server/app.js` (ws `approve` message passes `answer` when a string), `src/App.jsx` (`onAnswer` sends `answer`)
- Test: `tests/server/app.test.js` (append: ws `{ type: 'approve', id, allow: true, answer: 'Dark' }` resolves a question approval with `answer: 'Dark'`)

- [ ] **Step 1: Write the failing test**, **Step 2: run** `npx vitest run tests/server/app.test.js -t "question"` — Expected: FAIL.
- [ ] **Step 3: Implement**: card for `a.question`: the question text, one button per option (`label` + `description` small), a text box + "Send" for an own answer, a "Skip" button (`onAnswer(id, false)`), and "Or just say the number." No Allow/Deny/Always for questions.
- [ ] **Step 4: Run** the test — PASS; `npm run build` succeeds.
- [ ] **Step 5: Commit** `git commit -m "Question cards: options, own answer, skip"`

### Task 6: How to run a project (no AI)

**Files:**
- Create: `plugins/preview/run.js`, `plugins/preview/openclaw.plugin.json`
- Modify: `server/claude/session.js` (`--append-system-prompt` text gains: `If the project has a website, write .novi/run.json with {"command", "port", "pages": {"home": "/", …}} so it can be previewed.`)
- Test: `tests/server/previewRun.test.js`

**Interfaces:**
- Produces: `howToRun(dir) => { kind: 'command', command: string, port: number|null, pages: object } | { kind: 'static', root: string, pages: {} } | null`; `findPort(text) => number|null` (first `http://localhost:<n>` / `127.0.0.1:<n>` / `Local: http://…:<n>`).

- [ ] **Step 1: Write the failing tests** (temp dirs): run.json wins (`{ kind: 'command', command: 'npm run dev', port: 5173, pages: { home: '/', contact: '/contact' } }`); package.json `dev` → `npm run dev`, else `start` → `npm start`; `index.html` at root, else `public/`, else `dist/` → static with that root; empty dir → null; `findPort('  ➜  Local:   http://localhost:5174/')` → 5174; `claudeArgs()` prompt contains `.novi/run.json`.
- [ ] **Step 2: Run** `npx vitest run tests/server/previewRun.test.js` — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Preview: find how to run a project without AI"`

### Task 7: Running sites

**Files:**
- Create: `plugins/preview/sites.js`
- Test: `tests/server/previewSites.test.js` (fixture `tests/fixtures/fake-dev-server.mjs`: http server on an argv port printing `  ➜  Local:   http://localhost:<port>/`)

**Interfaces:**
- Consumes: Task 6 `howToRun`, `findPort`.
- Produces: `createSites({ spawnImpl = spawn, waitMs = 30_000 })` → `{ start(project, dir) => Promise<{ port, pages }>, stop(project), stopAll(), running(project) => boolean }`. Command: `spawn(command, { cwd: dir, shell: true, windowsHide: true })`, last 200 output lines kept; port = port printed in output, else `run.json` port once it accepts a connection; static: node http server on port 0 serving files under root (path traversal refused, `index.html` for `/`).
- Errors: `The site didn't start: <last non-empty output line>` (exit before a port), `The site didn't say which address it uses.` (no port in `waitMs`).

- [ ] **Step 1: Write the failing tests**: static serves index.html and refuses `/../secret`; command start returns the printed port (fixture prints 5174 while run.json says 5173 → 5174); second `start` of a running project returns the same port without spawning again; after the child exits, `running()` is false and `start` spawns again (Review Focus 2); exit with output `Error: Cannot find module` → that line; `stopAll()` kills every child (killTree from `server/claude/session.js`).
- [ ] **Step 2: Run** `npx vitest run tests/server/previewSites.test.js` — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Preview: run a project's site (command or static)"`

### Task 8: Preview port with one-time links

**Files:**
- Create: `plugins/preview/proxy.js`
- Test: `tests/server/previewProxy.test.js` (plain http in tests: `tls: null`)

**Interfaces:**
- Produces: `createPreviewProxy({ port = 3005, tls = null, ttlMs = 30 * 60_000, now = Date.now })` → `{ start(), stop(), port(), link({ project, targetPort, host }) => string }` where the link is `https://<host>:<port>/?novi=<token>` (`http://` when `tls` is null). A request with a valid unexpired `novi` token sets cookie `novi_preview=<token>; HttpOnly; Secure; SameSite=Lax; Path=/` and redirects to `/`; a request whose cookie token is valid is piped to `127.0.0.1:<targetPort>` (method, path, headers, body) and WebSocket upgrades are piped both ways with `net.connect`; anything else → 403 `Ask Novi for a new preview link.`. One target at a time: a newer `link()` for another project makes older tokens invalid.

- [ ] **Step 1: Write the failing tests**: no token → 403; token → 302 + cookie → page body from a target http server; expired token (`now` + 31 min) → 403 (Review Focus 4); token for project A after `link()` for project B → 403; WebSocket upgrade echo works through the proxy.
- [ ] **Step 2: Run** `npx vitest run tests/server/previewProxy.test.js` — FAIL.
- [ ] **Step 3: Implement** with `node:http` / `node:https` / `node:net` only.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Preview: protected preview port with one-time links"`

### Task 9: Preview plugin (tools, approval, picture, link)

**Files:**
- Create: `plugins/preview/index.js`
- Create: `plugins/screen/pageShot.js` (move `pageShot(url)` out of `plugins/screen/index.js`, add `{ width = 1280, height = 1400 }`; screen plugin keeps using it)
- Modify: `server/index.js` — pass Novi's HTTPS key/cert to `createNovi` so `api.runtime.tls = { key, cert }` (tests pass none → proxy uses plain http).
- Modify: `server/app.js` — runtime gains `tls`, `showLink({ url, label })` (to the asking device, built on the `link` transcript extra), `deviceHost()` (the Host header the active device's WebSocket used, without port; `localhost` for the laptop), `codingProject(name?) => { name, path } | null` (named → `memory.findProject`; else the current/last task's project); ws connection stores `ws.host = req.headers.host`.
- Test: `tests/server/previewPlugin.test.js`

**Interfaces:**
- Consumes: Tasks 6–8; `api.runtime.showImage`, `showLink`, `deviceHost`, `codingProject`.
- Produces: tools `preview_show { page?: string, project?: string }`, `preview_stop { project?: string }`; service `preview` (start proxy on `NOVI_PREVIEW_PORT` with Novi's TLS cert from `api.runtime.tls`; stop → `sites.stopAll()` + proxy stop).

- [ ] **Step 1: Write the failing tests** (fake sites, fake proxy, fake shot):
  - no project → error `Which project? Say "show me the homepage of portfolio".`
  - `howToRun` → null → `{ error: "I don't know how to run this project yet.", askClaude: true }` (Task 10 hands it to Claude)
  - command project → gate asks `Start the portfolio site to preview it?` (category `preview`, grantable); static → no question; already running → no question.
  - `page: 'contact'` with run.json pages → picture of `http://127.0.0.1:<port>/contact` at 390×844, `showLink` with the proxy link for `deviceHost()`, note `Here's the contact page. Tap the link to open it live.`
  - unknown page and no matching link on the home page → home picture + note `I couldn't find a contact page, so here's the homepage.`
  - picture fails → link only, note `I couldn't take a picture, but here's the live link.`
  - `preview_stop` → `Stopped the portfolio preview.`; service stop calls `stopAll` (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run tests/server/previewPlugin.test.js tests/server/screenPlugin.test.js` — FAIL.
- [ ] **Step 3: Implement**. Page link lookup on the home page: fetch the home HTML, first `<a>` whose text contains the page word → its `href`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "Preview plugin: picture + live link of the project's site"`

### Task 10: Voice route + wrap-up

**Files:**
- Create: `server/brain/previewCommand.js`
- Modify: `server/brain/agent.js` (route before the AI, like `_browserCommand`), `server/brain/toolSelect.js` (group `preview`: preview homepage site website page dikhao), `tools/my-commands.json`, `CLAUDE.md`
- Test: `tests/server/previewCommand.test.js`, `tests/server/agent.test.js` (append)

**Interfaces:**
- Produces: `previewCommand(text) => { tool: 'preview_show', args: { page?, project? } } | { tool: 'preview_stop', args: {} } | null`.

- [ ] **Step 1: Write the failing tests**: "show me the homepage" → `{ page: 'home' }`; "show me the contact page" → `{ page: 'contact' }`; "show me the site / website" → `{ page: 'home' }`; "show me the homepage of portfolio" → `{ page: 'home', project: 'portfolio' }`; "homepage dikhao", "preview dikhao" → home; "stop the preview" → `preview_stop`; "show me the HTML" → null (code_show keeps it); "show me valorant" → null.
- Agent route: run the tool with `_runTool(…, { direct: true })`; when the output has `askClaude: true` and a task project exists, run `code_send_message { message: 'Please start the website so it can be previewed, and write .novi/run.json.' }` directly and reply `I asked Claude to start the site. Say "show me the homepage" again in a minute.` Test in agent.test.js with fake tools.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**. **Step 4: Run** — PASS.
- [ ] **Step 5:** add 3 commands to `tools/my-commands.json` (`show me the homepage` → preview_show, `show me the contact page` → preview_show, `stop the preview` → preview_stop); CLAUDE.md state line; full suite `TZ=Asia/Kolkata npx vitest run` → only the 2 known env failures; `npm run build`.
- [ ] **Step 6: Commit** `git commit -m "Preview by voice; wrap-up"`
