import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { AllProvidersUnavailableError } from '../brain/router.js';
import { CODER_TOOLS, TOOL_ALIASES, aliasInput, runTool } from './workspaceTools.js';
import { killTree } from '../claude/session.js';

export function coderSystemPrompt(cwd) {
  return [
    "You are Novi Coder, a careful software engineer working inside one project folder on the user's laptop.",
    `Project folder: ${cwd}. Operating system: ${process.platform === 'win32' ? 'Windows (run_command uses cmd.exe)' : process.platform}.`,
    'Look before you change anything: use list_files, search and read_file first, then edit_file for small changes or write_file for new files. All paths are relative to the project folder.',
    "Run the project's tests or build with run_command when it makes sense. If an action is denied, do not retry it; continue without it or explain what you need.",
    'Keep working until the instruction is done, then reply with a short plain-text summary (2-4 sentences) of what you changed and anything the user must do.',
  ].join('\n');
}

// A coding agent on the free Groq/Gemini router with the same interface as ClaudeSession.
export class FreeCoderSession extends EventEmitter {
  constructor({ router, cwd, onPermission, resumeSessionId, maxRounds = 25 }) {
    super();
    this.router = router;
    this.cwd = cwd;
    this.onPermission = onPermission;
    this.maxRounds = maxRounds;
    this.sessionId = resumeSessionId || crypto.randomUUID();
    this.exited = false;
    this.messages = [{ role: 'system', content: coderSystemPrompt(cwd) }];
    this.queue = [];
    this.running = false;
    this.provider = null;
    this.child = null;
    this.turns = 0;
    setImmediate(() => this._emit({ kind: 'init', sessionId: this.sessionId, model: 'novi-coder' }));
  }

  send(text) {
    if (this.exited) return;
    this.queue.push(text);
    if (!this.running) this._drain();
  }

  close() {
    if (!this.exited) this._exit(0);
  }

  async stop() {
    if (this.exited) return;
    if (this.child && this.child.exitCode === null) killTree(this.child.pid);
    this._exit(null);
  }

  _exit(code) {
    this.exited = true;
    this.emit('event', { kind: 'exit', code, error: null });
  }

  _emit(event) {
    if (!this.exited) this.emit('event', event);
  }

  _result(isError, text) {
    this._emit({ kind: 'result', isError, text, sessionId: this.sessionId, numTurns: this.turns });
  }

  async _drain() {
    this.running = true;
    while (this.queue.length && !this.exited) {
      const text = this.queue.shift();
      try {
        await this._turn(text);
      } catch (err) {
        this._result(true, `Novi Coder hit an error: ${err.message}`);
      }
    }
    this.running = false;
  }

  async _chat() {
    try {
      return await this.router.chat({ messages: this.messages, tools: CODER_TOOLS, purpose: 'long', only: this.provider || undefined });
    } catch (err) {
      if (!(err instanceof AllProvidersUnavailableError) || !this.provider) throw err;
      this._compact(); // the pinned provider failed: continue elsewhere with a text-only history
      return this.router.chat({ messages: this.messages, tools: CODER_TOOLS, purpose: 'long' });
    }
  }

  _compact() {
    const toolCalls = this.messages.filter((m) => m.role === 'tool').length;
    const notes = this.messages
      .slice(1)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content.trim().slice(0, 1500)}`);
    this.messages = [
      this.messages[0],
      { role: 'user', content: `Earlier in this session (you made ${toolCalls} tool calls; re-read files if you need details):\n${notes.join('\n')}\n\nContinue the current instruction.` },
    ];
    this.provider = null;
  }

  async _turn(text) {
    this.turns += 1;
    this.messages.push({ role: 'user', content: text });
    for (let round = 0; round < this.maxRounds; round++) {
      if (this.exited) return;
      let res;
      try {
        res = await this._chat();
      } catch (err) {
        const wait = err instanceof AllProvidersUnavailableError ? ` Try again in about ${Math.ceil(err.retryInMs / 1000)} seconds.` : '';
        this._result(true, `The free AI providers are busy or failing.${wait}`);
        return;
      }
      if (this.exited) return;
      this.provider = res.provider; // keep a turn on one provider (Gemini thought signatures)
      const { message } = res;
      this.messages.push(message);
      const calls = message.tool_calls || [];
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!calls.length) {
        const summary = content || 'Done.';
        this._emit({ kind: 'text', text: summary });
        this._result(false, summary);
        return;
      }
      if (content) this._emit({ kind: 'text', text: content });
      for (const call of calls) {
        if (this.exited) return;
        const { isError, output } = await this._runCall(call);
        if (this.exited) return;
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        this._emit({ kind: 'tool_result', id: call.id, isError, content: output.slice(0, 2000) });
      }
    }
    this._result(true, `Stopped after ${this.maxRounds} steps. Say "continue" to keep going.`);
  }

  async _runCall(call) {
    const name = call.function?.name;
    const alias = TOOL_ALIASES[name];
    if (!alias) return { isError: true, output: `Unknown tool ${name}` };
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { isError: true, output: 'Arguments were not valid JSON.' };
    }
    let input;
    try {
      input = aliasInput(this.cwd, name, args);
    } catch (err) {
      return { isError: true, output: err.message };
    }
    this._emit({ kind: 'tool_use', id: call.id, name: alias, input });
    const decision = await this.onPermission({ toolName: alias, input, description: name === 'run_command' ? input.command : '' });
    if (!decision.allow) return { isError: true, output: decision.message || 'Denied by the user.' };
    if (this.exited) return { isError: true, output: 'Cancelled.' };
    return runTool(this.cwd, name, args, { onChild: (child) => { this.child = child; } });
  }
}
