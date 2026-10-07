import fs from 'node:fs';
import path from 'node:path';

// One-time permission grants: "always allow" for medium-risk actions by category.
// Spec: docs/superpowers/specs/2026-10-08-novi-permission-grants-design.md

export const CATEGORY_LABELS = {
  files: 'editing files in a project',
  commands: 'running commands in a project',
  apps: 'opening apps and projects',
  browser: 'browser actions',
  screen: 'screen control (click and type)',
  projects: 'remembering projects',
  announce: 'announcements',
  'github-read': 'marking GitHub notifications read',
};

const TOOL_CATEGORY = {
  remember_project: 'projects',
  clock_announce: 'announce',
  github_mark_read: 'github-read',
  open_app: 'apps',
  open_project: 'apps',
  open_website: 'browser',
};

// Sends, posts, deletes, payments and choices that matter each time: always ask.
const NEVER = new Set(['gmail_send', 'github_comment', 'github_create_issue', 'memory_forget', 'reminder_cancel', 'forget_project', 'code_start_task', 'code_allow_edits']);
const RISKY_NAME = /(^|_)(send|post|comment|delete|remove|forget|cancel|pay|payment|purchase|buy|transfer|publish|issue|order)(_|$)/;

export const labelFor = (category) => CATEGORY_LABELS[category] || category;

export function classifyApproval({ toolName = '', pluginId = '', tier = 'medium', category, grantable, choices } = {}) {
  const cat = category || TOOL_CATEGORY[toolName] || pluginId || 'other';
  const ok = grantable !== false && tier === 'medium' && !choices?.length && !NEVER.has(toolName) && !RISKY_NAME.test(toolName);
  return { category: cat, label: labelFor(cat), grantable: ok };
}

const MAX_AUDIT = 200;

export class PermissionGrants {
  constructor(file) {
    this.file = file;
    this.data = { grants: {}, audit: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { grants: raw.grants && typeof raw.grants === 'object' ? raw.grants : {}, audit: Array.isArray(raw.audit) ? raw.audit : [] };
    } catch { /* missing or corrupt: start empty */ }
  }

  has(category) { return Boolean(this.data.grants[category]); }

  grant(category, by = 'screen') {
    this.data.grants[category] = { grantedAt: new Date().toISOString(), by };
    this._save();
  }

  revoke(category) {
    if (!this.data.grants[category]) return false;
    delete this.data.grants[category];
    this._save();
    return true;
  }

  list() {
    return Object.entries(this.data.grants).map(([category, g]) => ({ category, label: labelFor(category), ...g }));
  }

  record({ category, title }) {
    this.data.audit.unshift({ at: new Date().toISOString(), category, title });
    this.data.audit.length = Math.min(this.data.audit.length, MAX_AUDIT);
    this._save();
  }

  audit() { return this.data.audit; }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
