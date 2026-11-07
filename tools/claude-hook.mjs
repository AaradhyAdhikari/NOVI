#!/usr/bin/env node
// Claude Code's hooks (in ~/.claude/settings.json) run this for every session in every project: what Claude
// asks or reports goes to Novi as a card or a spoken line (plugins/claude-link/hooks.js). Novi not running,
// or no answer in time: it prints nothing, and Claude Code carries on and asks in its own window.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, '..', 'data', 'claude-hook.json');
// Stop too: Claude's next-step question waits there for an answer from the phone.
const WAITS_FOR_ANSWER = new Set(['PermissionRequest', 'PreToolUse', 'Stop']);
export const waitsForAnswer = (event) => WAITS_FOR_ANSWER.has(event);
const CARD_WAIT_MS = 125_000; // Novi's card waits 2 minutes
const NOTE_WAIT_MS = 3_000;
const BIG_FIELDS = ['content', 'new_string', 'old_string', 'edits'];
const KEEP_CHARS = 200;

// A card needs a file's name, not its contents: Novi takes at most 100 KB per request.
export function hookBody(hook, env = process.env) {
  const input = { ...(hook.tool_input || {}) };
  for (const field of BIG_FIELDS) {
    if (input[field] !== undefined) input[field] = JSON.stringify(input[field]).slice(0, KEEP_CHARS);
  }
  return { ...hook, tool_input: input, ...(env.NOVI_TASK ? { novi_task: true } : {}) };
}

function post(body, token, waitMs) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({
      host: '127.0.0.1', port: Number(process.env.NOVI_PORT) || 3001, path: '/api/plugin/claude-hook', method: 'POST',
      rejectUnauthorized: false, // Novi's own self-signed certificate, on this laptop only
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-novi-hook': token },
      timeout: waitMs,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve(res.statusCode === 200 ? text : ''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.end(data);
  });
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const hook = JSON.parse(raw);
  const { token } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const answers = waitsForAnswer(hook.hook_event_name);
  const reply = await post(hookBody(hook), token, answers ? CARD_WAIT_MS : NOTE_WAIT_MS);
  if (answers && reply && reply !== '{}') process.stdout.write(reply);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
