import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { normalizeEvent } from './stream.js';

export function claudeArgs({ resumeSessionId } = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompts', 'host',
    '--permission-prompt-tool', 'stdio',
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// One live Claude Code process. Follow-up messages go to the same stdin, so
// the conversation keeps its context; permission asks arrive as control requests.
export class ClaudeSession extends EventEmitter {
  constructor({ command, argsPrefix = [], cwd, resumeSessionId, onPermission, spawnImpl = spawn }) {
    super();
    this.onPermission = onPermission;
    this.sessionId = resumeSessionId || null;
    this.exited = false;
    this.proc = spawnImpl(command, [...argsPrefix, ...claudeArgs({ resumeSessionId })], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) this._handleLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (text) => this.emit('event', { kind: 'stderr', text: text.slice(0, 500) }));
    this.proc.stdin.on('error', () => {}); // EPIPE after exit is expected
    this.proc.on('error', (err) => this._exit(null, err.message));
    this.proc.on('exit', (code) => this._exit(code));

    this._write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'initialize' } });
  }

  _exit(code, error = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('event', { kind: 'exit', code, error });
  }

  _write(obj) {
    if (!this.exited && this.proc.stdin.writable) this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _handleLine(line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      this.emit('event', { kind: 'stderr', text: line.slice(0, 500) });
      return;
    }
    if (raw.type === 'control_request' && raw.request?.subtype === 'can_use_tool') {
      this._answerPermission(raw);
      return;
    }
    if (raw.type === 'control_request' || raw.type === 'control_response') return;
    for (const event of normalizeEvent(raw)) {
      if (event.kind === 'init' && event.sessionId) this.sessionId = event.sessionId;
      if (event.kind === 'result' && event.sessionId) this.sessionId = event.sessionId;
      this.emit('event', event);
    }
  }

  async _answerPermission(raw) {
    const { tool_name: toolName, input = {}, description = '' } = raw.request;
    let decision;
    try {
      decision = await this.onPermission({ toolName, input, description });
    } catch {
      decision = { allow: false, message: 'Novi could not get approval for this action.' };
    }
    const response = decision.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: decision.message || 'The user denied this action.' };
    this._write({ type: 'control_response', response: { subtype: 'success', request_id: raw.request_id, response } });
  }

  send(text) {
    this._write({ type: 'user', message: { role: 'user', content: text } });
  }

  close() {
    if (!this.exited) this.proc.stdin.end();
  }

  async stop({ graceMs = 5000 } = {}) {
    if (this.exited) return;
    this._write({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } });
    this.close();
    const exited = await new Promise((resolve) => {
      if (this.exited) return resolve(true);
      const timer = setTimeout(() => resolve(false), graceMs);
      this.proc.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) killTree(this.proc.pid);
  }
}
