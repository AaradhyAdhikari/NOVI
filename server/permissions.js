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

  request({ title, detail = '', tier, source }) {
    const approval = { id: crypto.randomUUID(), title, detail, tier, source, createdAt: Date.now() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(approval.id, false, 'timeout'), this.timeoutMs);
      this.items.set(approval.id, { approval, resolve, timer });
      this.emit('added', approval);
    });
  }

  resolve(id, allow, by = 'user') {
    const item = this.items.get(id);
    if (!item) return false;
    clearTimeout(item.timer);
    this.items.delete(id);
    item.resolve(Boolean(allow));
    this.emit('resolved', { id, allow: Boolean(allow), by });
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
