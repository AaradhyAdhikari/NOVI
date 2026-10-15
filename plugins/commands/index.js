import os from 'node:os';
import path from 'node:path';
import { definePluginEntry } from '#plugin-sdk';
import { classify } from './classify.js';
import { createRunner } from './runner.js';
import { createHistory } from './history.js';

// One PowerShell command line for requests no other tool covers (spec: laptop commands).
// look → runs at once (re-checked by PowerShell's parser) · change → spoken yes · danger → yes +
// voice PIN on every device · never → refused, with the command shown. Everything is kept in a
// history (Settings → History, "what commands did you run today?").
const NOT_LOOK_MS = 10 * 60_000;
const MAX_OUTPUT = 4000;
const cut = (s) => { const t = String(s || ''); return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n…(cut)` : t; };
const reply = (details) => ({ content: [], details: { sensitive: true, ...details } });
const who = (from) => (from && typeof from === 'object' && from.deviceId ? 'phone' : 'laptop');
const question = (purpose) => `${String(purpose || 'Run this command').trim().replace(/[.!?]+$/, '')}?`;
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || 'no details';

export function createCommandsPlugin({ runner = null, history = null, platform = process.platform, now = () => Date.now() } = {}) {
  return definePluginEntry({
    id: 'commands',
    name: 'Laptop commands',
    description: 'Run one PowerShell command on the laptop, with safety levels and a history.',
    register(api) {
      const run = runner || createRunner({ platform, home: os.homedir() });
      const log = history || createHistory({ file: path.join(api.runtime?.dataDir || 'data', 'commands', 'history.jsonl'), logger: api.logger });
      const notLook = new Map(); // command → time it failed the parser check
      let lastFrom = 'laptop';
      const levelOf = (command) => {
        const c = classify(command);
        const t = notLook.get(command);
        return c.level === 'look' && t && now() - t < NOT_LOOK_MS ? { level: 'change', reason: 'it did more than look' } : c;
      };

      api.registerTool({
        name: 'laptop_run',
        description: 'Run ONE PowerShell command on the laptop when no other tool fits (disk space, memory/CPU use, IP, file sizes, renaming many files…). Prefer read-only commands. purpose = what it does in a few words, e.g. "Check free space on D:". The user is asked first for anything that changes something. Never ask the user to paste commands.',
        parameters: { type: 'object', properties: { command: { type: 'string', description: 'One PowerShell command line' }, purpose: { type: 'string', description: 'What it does, a few words' } }, required: ['command', 'purpose'] },
        async execute(_id, { command, purpose } = {}) {
          const { level } = levelOf(command);
          const entry = { from: lastFrom, level, purpose, command };
          if (level === 'never') return reply({ level, error: "I won't run that." });
          let r;
          try {
            r = await run.run({ command, look: level === 'look' });
          } catch (err) {
            const error = String(err.message) === 'not-windows' ? 'Commands work only on Windows.' : `I couldn't run that: ${err.message}`;
            log.add({ ...entry, ran: false, ok: false, output: error });
            return reply({ level, error });
          }
          if (r.notLook) {
            notLook.set(command, now());
            log.add({ ...entry, ran: false, ok: false, output: 'did more than look; not run' });
            return reply({ level, needsApproval: true, error: "That command does more than look, so I'll ask first." });
          }
          const output = cut(r.output);
          log.add({ ...entry, ran: true, ok: r.ok, exitCode: r.exitCode, output });
          const note = r.timedOut ? 'That took too long, so I stopped it.'
            : !r.ok ? `That didn't work: ${firstLine(output)}`
            : output || 'Done.';
          return reply({ level, ok: Boolean(r.ok), exitCode: r.exitCode ?? null, output, note });
        },
      });

      api.registerTool({
        name: 'commands_history',
        description: 'The commands Novi ran on the laptop (newest first). Read-only.',
        parameters: { type: 'object', properties: { today: { type: 'boolean' }, limit: { type: 'number' } } },
        async execute(_id, { today = false, limit = 20 } = {}) {
          const entries = log.list({ today, limit: Math.min(100, Math.max(1, Number(limit) || 20)) });
          return reply({ entries, note: today ? log.summary() : `${entries.length} recent commands.` });
        },
      });

      api.on('before_tool_call', ({ toolName, params = {}, from }) => {
        if (toolName !== 'laptop_run') return undefined;
        lastFrom = who(from);
        const { level, reason } = levelOf(params.command);
        if (level === 'look') return undefined;
        if (level === 'never') {
          log.add({ from: lastFrom, level, purpose: params.purpose, command: params.command, ran: false, ok: false, output: `refused: ${reason}` });
          return { block: true, blockReason: `I won't run that: ${reason}. Here's the command if you want to run it yourself: ${params.command}` };
        }
        return { requireApproval: { title: question(params.purpose), description: String(params.command || ''), severity: 'warning', category: 'commands', grantable: false, ...(level === 'danger' ? { pin: true } : {}) } };
      });

      api.on('after_tool_call', ({ toolName, params = {}, error }) => {
        if (toolName !== 'laptop_run' || !/declined/i.test(String(error || ''))) return;
        log.add({ from: lastFrom, level: levelOf(params.command).level, purpose: params.purpose, command: params.command, ran: false, ok: false, output: 'declined' });
      });
    },
  });
}

export default createCommandsPlugin();
