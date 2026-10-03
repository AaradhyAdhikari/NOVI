# Writing a Novi plugin

Every Novi feature is a plugin. Plugins use the **same shape as OpenClaw plugins**, so they can move to OpenClaw later with a thin adapter instead of a rewrite.

## 1. Folder layout

```
plugins/<id>/
  openclaw.plugin.json
  index.js
```

Novi loads every folder in `plugins/` at startup (`npm.cmd start` / `Start Novi.cmd`) and prints them on the `Plugins:` line. A broken plugin is skipped with a warning; Novi keeps running.

## 2. Manifest — `openclaw.plugin.json`

```json
{
  "id": "clock",
  "name": "Clock",
  "description": "Tells the time and can announce a message.",
  "categories": ["other"],
  "contracts": { "tools": ["clock_now", "clock_announce"] },
  "activation": { "onStartup": true },
  "configSchema": { "type": "object", "additionalProperties": false }
}
```

`id` must match the code, and `contracts.tools` must list exactly the tools the plugin registers.

## 3. Code — `index.js`

```js
import { definePluginEntry } from '#plugin-sdk';

export default definePluginEntry({
  id: 'clock',
  name: 'Clock',
  description: 'Tells the time and can announce a message.',
  register(api) {
    api.registerTool({
      name: 'clock_now',
      description: 'Get the current date and time on the laptop.',   // the AI reads this to decide when to use the tool
      parameters: { type: 'object', properties: {} },                 // JSON Schema
      async execute(toolCallId, params) {
        return { content: [{ type: 'text', text: new Date().toString() }], details: { iso: new Date().toISOString() } };
      },
    });

    api.on('before_tool_call', ({ toolName, params }) => {
      if (toolName !== 'clock_announce') return undefined;            // no approval needed
      return { requireApproval: { title: 'Announce a message', description: params.message, severity: 'warning' } };
    });
  },
});
```

See [`plugins/clock`](../plugins/clock) for the full working example.

## 4. Approvals and blocking (`before_tool_call`)

Return one of:

| Return | What Novi does |
|---|---|
| `undefined` | Runs the tool (reading, searching, opening things) |
| `{ requireApproval: { title, description, severity: 'info' } }` | Runs without asking (logged only) |
| `{ requireApproval: { …, severity: 'warning' } }` | **Allow/Deny card**, also spoken; voice "yes" works. `description` is the card's detail (e.g. the full email) |
| `{ requireApproval: { …, severity: 'critical' } }` | **High risk**: on-screen confirmation only |
| `{ block: true, blockReason }` | Doesn't run; `blockReason` goes back to the AI (use it for "which account?" or invalid input) |

A hook only sees **its own plugin's tools**. If a hook throws, the call is blocked (never silently allowed).

## 5. What a plugin can use

| `api.` | Meaning |
|---|---|
| `registerTool`, `on('before_tool_call')` | Same as OpenClaw |
| `pluginConfig` | Settings from `.env` named `NOVI_PLUGIN_<ID>_<KEY>`, e.g. `NOVI_PLUGIN_GITHUB_CLIENT_ID` → `api.pluginConfig.client_id` |
| `runtime.speak(text)` | Say something on every connected device |
| `runtime.openUrl(url)` | Open a link in the laptop's browser |
| `runtime.memory`, `runtime.accounts`, `runtime.tasks` | Novi's memory, connected accounts and coding tasks |
| `logger` | `console`-style logging |

`runtime` is the only Novi-specific part; the future OpenClaw adapter supplies the same services.

## 6. Results and privacy

`execute` returns `{ content: [{ type: 'text', text }], details }`. The AI sees `details` plus the text. Put `sensitive: true` in `details` for private data (email, private repos): that turn then stays on Groq only and is never sent to Gemini.

Throw `UserFacingError` (from `server/errors.js`) for errors Novi should say out loud.

## 7. Testing a plugin

```js
import path from 'node:path';
import { PluginHost } from '../../server/plugins/host.js';

const host = new PluginHost({ runtime: { speak() {} } });
await host.loadDirectory(path.resolve('plugins'));
await host.get('clock_now').run({});        // runs the tool
await host.get('clock_announce').gate({});  // shows the approval Novi would ask for
```

## 8. Checklist

- [ ] Tool names are prefixed with the plugin id (`github_…`) and unique.
- [ ] Every tool that sends, posts, changes or deletes has a `warning` (or `critical`) approval with a clear title and the full content as `description`.
- [ ] Private data results set `details.sensitive = true`.
- [ ] Secrets come from `api.pluginConfig` / `.env`, never hard-coded.
- [ ] A test loads the plugin and checks each tool's `run` and `gate`.

## OpenClaw mapping (for the future move)

| Novi | OpenClaw |
|---|---|
| `#plugin-sdk` → `definePluginEntry` | `openclaw/plugin-sdk/plugin-entry` → `definePluginEntry` |
| `api.registerTool` (JSON Schema params) | `api.registerTool` (TypeBox params — JSON Schema compatible) |
| `api.on('before_tool_call')` → `requireApproval` / `block` | identical hook and result shape |
| `api.runtime.*` | provided by the Novi→OpenClaw adapter |
| `details.sensitive` | adapter maps to OpenClaw model routing |
