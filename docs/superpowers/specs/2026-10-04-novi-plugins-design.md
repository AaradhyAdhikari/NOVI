# NOVI — OpenClaw-shaped Plugin System — Design Spec

Date: 2026-10-04
Status: Draft for review
Context: OpenClaw trial (2026-10-03) showed OpenClaw is not yet reliable on native Windows with free models (setup workarounds, approval flow not demonstrable). Decision: keep building on Novi's core now, but make every feature a plugin in **OpenClaw's plugin shape**, so a later move is one adapter, not a rewrite.

## 1. Goal

1. Adding a feature = adding one folder under `plugins/` (no edits to Novi's core).
2. Plugin code uses the same shapes as OpenClaw plugins: `openclaw.plugin.json` manifest, `definePluginEntry({ id, name, description, register(api) })`, `api.registerTool({ name, description, parameters, execute })`, `api.on('before_tool_call', …)` returning `{ requireApproval }` or `{ block, blockReason }`.
3. Novi's existing features (coding tasks, laptop basics, Gmail/accounts) become built-in plugins with no behaviour change; all 200 tests stay green.
4. A short guide (`docs/PLUGINS.md`) shows how to write a plugin, with one tiny example plugin.

**Out of scope now:** the actual OpenClaw adapter, loading plugins from npm/ClawHub, hot reload, a plugin settings UI.

## 2. Plugin format (mirrors OpenClaw)

```
plugins/<id>/
  openclaw.plugin.json   { id, name, description, contracts: { tools: [...] } }
  index.js               export default definePluginEntry({ id, name, description, register(api) { ... } })
```
(JavaScript, not TypeScript, so Novi needs no build step; OpenClaw accepts JS entry points.)

### `api` available to plugins

| Member | Same as OpenClaw? | Meaning |
|---|---|---|
| `api.registerTool({ name, description, parameters, execute(id, params) })` | yes | `parameters` is JSON Schema; `execute` returns `{ content: [{ type: 'text', text }], details? }` |
| `api.on('before_tool_call', (event) => result)` | yes | `event = { toolName, params, toolCallId }`; return `undefined` (proceed), `{ requireApproval: { title, description, severity: 'info'|'warning'|'critical' } }`, or `{ block: true, blockReason }` |
| `api.runtime` | **Novi-specific** | Services Novi provides: `memory`, `accounts`, `tasks`, `openUrl`, `logger`. The future OpenClaw adapter must supply equivalents. |
| `api.pluginConfig` | yes (name) | Values from `NOVI_PLUGIN_<ID>_<KEY>` env vars, e.g. `NOVI_PLUGIN_GITHUB_CLIENT_ID` |

### Novi behaviour mapping
- `requireApproval.severity`: `info` → no card (log only), `warning` → Novi **medium** (Allow/Deny card, voice "yes" works), `critical` → Novi **high** (screen-only). `description` becomes the card detail (e.g. full email body).
- `block` → the tool does not run; `blockReason` is returned to the model as `{ error }` (used for "which account?" questions and validation).
- `details.sensitive === true` in a tool result keeps the turn on private providers (existing Groq-only rule).
- A `before_tool_call` hook only sees its own plugin's tools unless it opts in (prevents one plugin silently gating another).

## 3. Components

- `server/plugins/sdk.js` — `definePluginEntry` (identity helper, validates shape).
- `server/plugins/host.js` — `PluginHost`: loads built-in plugins + every `plugins/*/` folder, validates manifest ↔ registered tools (`contracts.tools` must match), exposes a ToolRegistry-compatible view to the agent (`schemas()`, `get(name)`), and runs `before_tool_call` hooks to produce a **gate** for each call.
- Agent change: `_runTool` asks the tool's `gate(args)` → `{ block }` / `{ approval: { title, detail, tier } }` / nothing; existing `tier/describe/detail/precheck` tools keep working through a compatibility gate.
- Built-in plugins in `server/plugins/builtin/`: `coding` (code_* + projects), `laptop` (open_website, YouTube, open_app), `accounts` (accounts_*, gmail_*). They wrap the existing tool implementations, so behaviour and tests are unchanged.
- `plugins/clock/` — example plugin with two tools: `clock_now` (tells the date and time, no approval) and `clock_announce` (speaks a message on every connected device; gated with `severity: 'warning'` to demonstrate approvals).
- `docs/PLUGINS.md` — how to write a plugin; OpenClaw mapping table; checklist.

## 4. Error handling
- A plugin that fails to load (bad manifest, throws in `register`, tool name clash, contract mismatch) is skipped with a clear startup warning; Novi keeps running.
- A hook that throws → that call is blocked with "A plugin check failed", never silently allowed.
- `execute` throwing → `{ error }` to the model (as today); `UserFacingError` text is spoken.

## 5. Testing
- Host: loads a temp plugin folder; manifest/contract mismatch skipped; duplicate tool names rejected; `registerTool` schema passthrough; `execute` result mapping (`content`/`details`).
- Gates: `warning` → medium approval with description as detail; `critical` → high; `info` → no approval; `block` → `{ error }`, tool not run; hook exception → blocked; hooks scoped to own plugin.
- Agent: plugin tool approved/denied end-to-end; `details.sensitive` triggers privacy rule.
- Regression: full existing suite (200) passes with built-ins served through the host; example plugin loads at startup.
