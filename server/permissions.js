import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';

export const LOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'Task', 'Agent', 'ToolSearch']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export const HIGH_RISK_COMMANDS = [
  /\brm\s+(-\w*[rf]\w*\s*)+/i,
  /\bdel\s+(\S+\s+)*\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f/i,
  /\s--force\b/i,
  /\bnpm\s+publish\b/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|Invoke-Expression)\b/i,
];

export function isInside(projectPath, target) {
  if (!projectPath || !target) return false;
  const root = path.resolve(projectPath);
  const rel = path.relative(root, path.resolve(root, target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function classifyClaudeTool(toolName, input = {}, projectPath) {
  if (LOW_TOOLS.has(toolName)) return 'low';
  if (EDIT_TOOLS.has(toolName)) {
    const target = input.file_path || input.notebook_path || input.path;
    return target && !isInside(projectPath, target) ? 'high' : 'medium';
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command || '');
    return HIGH_RISK_COMMANDS.some((re) => re.test(command)) ? 'high' : 'medium';
  }
  return 'medium';
}

export class ApprovalQueue extends EventEmitter {
  constructor({ timeoutMs = 5 * 60_000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.items = new Map();
  }

  // Resolves to { allow, choice }. `prompt` is what Novi says aloud; `choices` are extra options
  // (e.g. { id: 'claude', label: 'Use Claude' }) the user can pick by voice or button.
  decide({ title, detail = '', tier, source, prompt, choices }) {
    const approval = { id: crypto.randomUUID(), title, detail, tier, source, createdAt: Date.now(), ...(prompt ? { prompt } : {}), ...(choices?.length ? { choices } : {}) };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(approval.id, false, 'timeout'), this.timeoutMs);
      this.items.set(approval.id, { approval, resolve, timer });
      this.emit('added', approval);
    });
  }

  request(options) {
    return this.decide(options).then((d) => d.allow);
  }

  resolve(id, allow, by = 'user', choice = null) {
    const item = this.items.get(id);
    if (!item) return false;
    clearTimeout(item.timer);
    this.items.delete(id);
    const picked = choice && item.approval.choices?.some((c) => c.id === choice) ? choice : null;
    item.resolve({ allow: Boolean(allow), choice: picked });
    this.emit('resolved', { id, allow: Boolean(allow), by, ...(picked ? { choice: picked } : {}) });
    return true;
  }

  pending() {
    return [...this.items.values()].map((i) => i.approval);
  }

  latest({ excludeTier } = {}) {
    const list = this.pending().filter((a) => a.tier !== excludeTier);
    return list[list.length - 1] || null;
  }

  denyWhere(predicate, reason = 'cancelled') {
    for (const approval of this.pending()) if (predicate(approval)) this.resolve(approval.id, false, reason);
  }
}
