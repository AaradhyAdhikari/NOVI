import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionGrants, classifyApproval, labelFor } from '../../server/grants.js';
import { ApprovalQueue } from '../../server/permissions.js';
import { Agent, quickCommand } from '../../server/brain/agent.js';

let dir;
let file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-grants-')); file = path.join(dir, 'permissions.json'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('classifyApproval', () => {
  it('puts safe, repeatable actions in grantable categories', () => {
    expect(classifyApproval({ toolName: 'open_app', pluginId: 'laptop' })).toEqual({ category: 'apps', label: labelFor('apps'), grantable: true });
    expect(classifyApproval({ toolName: 'clock_announce', pluginId: 'clock' }).category).toBe('announce');
    expect(classifyApproval({ toolName: 'screen_click', pluginId: 'screen' }).category).toBe('screen');
    expect(classifyApproval({ category: 'files', tier: 'medium' })).toMatchObject({ category: 'files', grantable: true });
  });

  it('never makes sends, posts, deletes, payments or high-risk actions grantable', () => {
    for (const toolName of ['gmail_send', 'github_comment', 'github_create_issue', 'memory_forget', 'reminder_cancel', 'forget_project', 'shop_pay', 'files_delete', 'code_start_task']) {
      expect(classifyApproval({ toolName, pluginId: 'x' }).grantable, toolName).toBe(false);
    }
    expect(classifyApproval({ toolName: 'open_app', tier: 'high' }).grantable).toBe(false);
    expect(classifyApproval({ toolName: 'open_app', choices: [{ id: 'a', label: 'A' }] }).grantable).toBe(false);
    expect(classifyApproval({ toolName: 'screen_type', pluginId: 'screen', grantable: false }).grantable).toBe(false);
  });
});

describe('PermissionGrants store', () => {
  it('grants, lists, revokes and survives a restart', () => {
    const g = new PermissionGrants(file);
    expect(g.has('apps')).toBe(false);
    g.grant('apps', 'voice');
    expect(new PermissionGrants(file).has('apps')).toBe(true);
    expect(g.list()).toEqual([{ category: 'apps', label: labelFor('apps'), grantedAt: expect.any(String), by: 'voice' }]);
    expect(g.revoke('apps')).toBe(true);
    expect(new PermissionGrants(file).has('apps')).toBe(false);
  });

  it('keeps the newest 200 auto-allowed actions, newest first', () => {
    const g = new PermissionGrants(file);
    for (let i = 0; i < 205; i++) g.record({ category: 'apps', title: `Open ${i}` });
    expect(g.audit()).toHaveLength(200);
    expect(g.audit()[0].title).toBe('Open 204');
  });
});

describe('ApprovalQueue with grants', () => {
  it('auto-allows a granted, grantable medium action without showing a card, and audits it', async () => {
    const grants = new PermissionGrants(file);
    grants.grant('apps');
    const q = new ApprovalQueue({ grants });
    const shown = [];
    const auto = [];
    q.on('added', (a) => shown.push(a));
    q.on('auto_allowed', (e) => auto.push(e));
    const d = await q.decide({ title: 'Open Spotify', tier: 'medium', source: 'novi', category: 'apps', grantable: true });
    expect(d).toEqual({ allow: true, choice: null, auto: true });
    expect(shown).toEqual([]);
    expect(auto).toEqual([{ category: 'apps', title: 'Open Spotify' }]);
    expect(grants.audit()[0]).toMatchObject({ category: 'apps', title: 'Open Spotify' });
  });

  it('shows grantable cards with an "always" offer; answering "always" stores the grant', async () => {
    const grants = new PermissionGrants(file);
    const q = new ApprovalQueue({ grants });
    q.on('added', (a) => {
      expect(a.grant).toEqual({ category: 'screen', label: labelFor('screen') });
      q.resolve(a.id, true, 'screen', null, { always: true });
    });
    const d = await q.decide({ title: 'Click Send', tier: 'medium', source: 'novi', category: 'screen', grantable: true });
    expect(d.allow).toBe(true);
    expect(grants.list()[0]).toMatchObject({ category: 'screen', by: 'screen' });
  });

  it('never auto-allows high-risk or non-grantable approvals, and gives them no "always" offer', async () => {
    const grants = new PermissionGrants(file);
    grants.grant('apps');
    const q = new ApprovalQueue({ grants });
    const shown = [];
    q.on('added', (a) => { shown.push(a); q.resolve(a.id, false); });
    await q.decide({ title: 'x', tier: 'high', source: 'novi', category: 'apps', grantable: true });
    await q.decide({ title: 'Send email', tier: 'medium', source: 'novi', category: 'apps', grantable: false });
    expect(shown).toHaveLength(2);
    expect(shown.every((a) => !a.grant)).toBe(true);
  });

  it('"always" on a non-grantable card is ignored', async () => {
    const grants = new PermissionGrants(file);
    const q = new ApprovalQueue({ grants });
    q.on('added', (a) => q.resolve(a.id, true, 'screen', null, { always: true }));
    await q.decide({ title: 'Send email', tier: 'medium', source: 'novi', category: 'gmail', grantable: false });
    expect(grants.list()).toEqual([]);
  });
});

describe('agent and voice', () => {
  const call = (name) => ({ id: 'c1', type: 'function', function: { name, arguments: '{}' } });
  function setup(toolName, grants) {
    const ran = [];
    const tools = {
      schemas: () => [],
      get: (name) => ({ name, pluginId: 'laptop', gate: async () => ({ approval: { title: `Do ${name}`, detail: '', tier: 'medium' } }), run: async () => { ran.push(name); return { done: true }; } }),
    };
    const steps = [{ message: { role: 'assistant', content: null, tool_calls: [call(toolName)] }, provider: 'groq' }, { message: { role: 'assistant', content: 'Done.' }, provider: 'groq' }];
    let i = 0;
    const approvals = new ApprovalQueue({ grants });
    const agent = new Agent({ router: { chat: async () => steps[i++] }, tools, approvals, memory: { listProjects: () => [] }, tasks: { status: () => ({ active: false }) } });
    return { agent, approvals, ran };
  }

  it('the agent passes the category, so a granted kind of action runs without asking', async () => {
    const grants = new PermissionGrants(file);
    grants.grant('apps');
    const { agent, approvals, ran } = setup('open_app', grants);
    let asked = false;
    approvals.on('added', () => { asked = true; });
    await agent.handle('open spotify');
    expect(asked).toBe(false);
    expect(ran).toEqual(['open_app']);
  });

  it('understands "yes, always" and grants the latest card\'s category', async () => {
    for (const t of ['yes always', 'Yes, always.', 'always allow', 'allow always', 'yes, always allow it']) expect(quickCommand(t), t).toBe('approve-always');
    const grants = new PermissionGrants(file);
    const { agent, approvals } = setup('open_app', grants);
    const pending = agent.handle('open spotify');
    await new Promise((r) => setTimeout(r, 0));
    expect(await agent.handle('yes always')).toMatch(/always/i);
    await pending;
    expect(grants.has('apps')).toBe(true);
    expect(approvals.pending()).toEqual([]);
  });

  it('"yes, always" on a card that cannot be remembered is just a yes', async () => {
    const grants = new PermissionGrants(file);
    const { agent } = setup('gmail_send', grants);
    const pending = agent.handle('send it');
    await new Promise((r) => setTimeout(r, 0));
    expect(await agent.handle('yes always')).toMatch(/can't remember|each time/i);
    await pending;
    expect(grants.list()).toEqual([]);
  });
});

describe('coding agent and plugins pass categories', () => {
  it('coder edits inside the project are "files", shell commands "commands"; risky ones stay high', async () => {
    const { TaskManager } = await import('../../server/claude/taskManager.js');
    const seen = [];
    const approvals = { request: async (o) => { seen.push(o); return true; } };
    const tm = new TaskManager({ memory: { listProjects: () => [] }, approvals, createSession: () => ({}) });
    const task = { path: 'C:\proj', agentName: 'Novi Coder' };
    await tm._onPermission(task, { toolName: 'Edit', input: { file_path: 'C:\proj\a.js' } });
    await tm._onPermission(task, { toolName: 'Bash', input: { command: 'npm test' } });
    await tm._onPermission(task, { toolName: 'Bash', input: { command: 'git push' } });
    expect(seen.map((o) => [o.category, o.grantable])).toEqual([['files', true], ['commands', true], ['commands', false]]);
  });

  it('a plugin can name its own category or mark an approval as never grantable', async () => {
    const { PluginHost } = await import('../../server/plugins/host.js');
    const h = new PluginHost({ runtime: {}, env: {}, logger: { warn() {} } });
    h.register({ id: 'screen', name: 'S', register(api) {
      api.registerTool({ name: 'screen_click', execute: async () => ({}) });
      api.on('before_tool_call', ({ params }) => ({ requireApproval: { title: 'Click', severity: 'warning', category: 'screen', grantable: !params.password } }));
    } });
    expect((await h.get('screen_click').gate({})).approval).toMatchObject({ category: 'screen', grantable: true });
    expect((await h.get('screen_click').gate({ password: true })).approval).toMatchObject({ grantable: false });
  });
});

describe('GitHub notifications (user said yes, 2026-10-07)', () => {
  it('marking notifications read can be always-allowed; commenting and creating issues always ask', () => {
    expect(classifyApproval({ toolName: 'github_mark_read', pluginId: 'github' })).toEqual({ category: 'github-read', label: 'marking GitHub notifications read', grantable: true });
    expect(classifyApproval({ toolName: 'github_comment', pluginId: 'github' }).grantable).toBe(false);
    expect(classifyApproval({ toolName: 'github_create_issue', pluginId: 'github' }).grantable).toBe(false);
  });

  it('the first card offers "Always allow marking GitHub notifications read", then it stops asking, and revoking brings the card back', async () => {
    const grants = new PermissionGrants(file);
    const q = new ApprovalQueue({ grants });
    const cards = [];
    q.on('added', (a) => { cards.push(a); q.resolve(a.id, true, 'screen', null, { always: true }); });
    const ask = () => q.decide({ title: 'Mark 3 notifications read', tier: 'medium', source: 'novi', ...classifyApproval({ toolName: 'github_mark_read', pluginId: 'github' }) });
    await ask();
    expect(cards[0].grant).toEqual({ category: 'github-read', label: 'marking GitHub notifications read' });
    expect((await ask()).auto).toBe(true);
    expect(cards).toHaveLength(1);
    grants.revoke('github-read');
    await ask();
    expect(cards).toHaveLength(2);
  });
});
