import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import { labelFor } from './grants.js';

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
  // grants: PermissionGrants (server/grants.js) — "always allow" by category.
  // trust: remote trust policy (server/remoteTrust.js) — what a phone must prove to allow.
  constructor({ timeoutMs = 5 * 60_000, grants = null, trust = null } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.grants = grants;
    this.trust = trust;
    this.items = new Map();
  }

  // Resolves to { allow, choice } (plus auto: true when a grant allowed it without asking).
  // `prompt` is what Novi says aloud; `choices` are extra options (e.g. { id: 'claude', label: 'Use Claude' })
  // the user can pick by voice or button. `category` + `grantable` come from classifyApproval().
  // kind: 'delete' | 'payment' — never grantable, and from a phone needs a passkey.
  decide({ title, detail = '', tier, source, prompt, choices, category, grantable = false, kind }) {
    const canGrant = Boolean(this.grants && grantable && category && tier === 'medium' && !kind);
    if (canGrant && this.grants.has(category)) {
      this.grants.record({ category, title });
      this.emit('auto_allowed', { category, title });
      return Promise.resolve({ allow: true, choice: null, auto: true });
    }
    const approval = {
      id: crypto.randomUUID(), title, detail, tier, source, createdAt: Date.now(), ...(kind ? { kind } : {}),
      ...(prompt ? { prompt } : {}), ...(choices?.length ? { choices } : {}),
      ...(canGrant ? { grant: { category, label: labelFor(category) } } : {}),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(approval.id, false, 'timeout'), this.timeoutMs);
      this.items.set(approval.id, { approval, resolve, timer });
      this.emit('added', approval);
    });
  }

  request(options) {
    return this.decide(options).then((d) => d.allow);
  }

  // { always: true } (button "Always allow …" or voice "yes, always") also stores the grant.
  // from: 'local' or { deviceId } — who answered (checked against remote trust rules from Task 3 on).
  // An allow from a phone without the proof it needs is refused: returns false, the approval stays
  // pending and 'needs_proof' tells that phone what to give (PIN, passkey, or "at the laptop").
  resolve(id, allow, by = 'user', choice = null, { always = false, from = 'local', proof = null } = {}) {
    const item = this.items.get(id);
    if (!item) return false;
    if (allow && this.trust) {
      const verdict = this.trust.check(item.approval, from, proof);
      if (!verdict.ok) {
        this.emit('needs_proof', { id, need: verdict.need, from });
        return false;
      }
    }
    clearTimeout(item.timer);
    this.items.delete(id);
    if (allow && always && item.approval.grant && this.grants) this.grants.grant(item.approval.grant.category, by);
    const picked = choice && item.approval.choices?.some((c) => c.id === choice) ? choice : null;
    item.resolve({ allow: Boolean(allow), choice: picked });
    this.emit('resolved', { id, allow: Boolean(allow), by, ...(picked ? { choice: picked } : {}) });
    return true;
  }

  pending() {
    return [...this.items.values()].map((i) => i.approval);
  }

  latest({ excludeTier } = {}) {
    // Deletes and payments are never answered by a plain spoken "yes".
    const list = this.pending().filter((a) => a.tier !== excludeTier && !a.kind);
    return list[list.length - 1] || null;
  }

  denyWhere(predicate, reason = 'cancelled') {
    for (const approval of this.pending()) if (predicate(approval)) this.resolve(approval.id, false, reason);
  }
}
