import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { classifyClaudeTool, EDIT_TOOLS } from '../permissions.js';
import { Narrator } from '../narrator.js';
import { UserFacingError } from '../errors.js';

export function permissionTitle(toolName, input = {}, agentName = 'Claude') {
  if (toolName === 'Bash' || toolName === 'PowerShell') return `${agentName} wants to run: ${input.command}`;
  if (toolName === 'Write') return `${agentName} wants to create/overwrite ${input.file_path}`;
  if (EDIT_TOOLS.has(toolName)) return `${agentName} wants to edit ${input.file_path || input.notebook_path}`;
  return `${agentName} wants to use ${toolName}`;
}

export class TaskManager extends EventEmitter {
  constructor({ memory, approvals, createSession, agentName = 'Claude', agentLabels = {}, narratorIntervalMs = 8000 }) {
    super();
    this.agentName = agentName; // label of the default coder
    this.agentLabels = agentLabels; // e.g. { 'novi-coder': 'Novi Coder', claude: 'Claude' }
    this.memory = memory;
    this.approvals = approvals;
    this.createSession = createSession;
    this.narratorIntervalMs = narratorIntervalMs;
    this.task = null;
    this.session = null;
    this.narrator = null;
    this.stopping = false;
  }

  isRunning() {
    return Boolean(this.task?.status === 'running' && this.session && !this.session.exited);
  }

  start(projectName, instruction, { agent } = {}) {
    if (this.isRunning()) throw new UserFacingError(`${this.task.agentName || this.agentName} is already working on ${this.task.project}. Say "stop" first, or give it a follow-up.`);
    const project = this.memory.findProject(projectName);
    if (!project) throw new UserFacingError(`I don't know a project called "${projectName}". Tell me its folder and I'll remember it.`);
    this._closeSession();
    const task = {
      id: crypto.randomUUID(),
      project: project.name,
      path: project.path,
      instruction,
      status: 'running',
      startedAt: new Date().toISOString(),
      sessionId: null,
      summary: null,
      updates: [],
      allowEdits: false,
      agent: agent || null,
      agentName: this.agentLabels[agent] || this.agentName,
    };
    this.task = task;
    this.memory.touchProject(project.name);
    this.memory.addTask(this._persistable(task));
    this._openSession(task, null);
    this.session.send(instruction);
    this._emitTask();
    return this.status();
  }

  send(text) {
    const task = this.task || this._restoreLastTask();
    if (!task) throw new UserFacingError('There is no coding task to continue. Ask me to start one first.');
    if (!this.session || this.session.exited) this._openSession(task, task.sessionId);
    task.status = 'running';
    this.session.send(text);
    this._save(task);
    this._emitTask();
    return this.status();
  }

  setAllowEdits(value) {
    if (!this.task) return;
    this.task.allowEdits = Boolean(value);
    this._emitTask();
  }

  async stop() {
    if (!this.session || this.session.exited) return false;
    this.stopping = true;
    this.narrator?.dispose();
    this.approvals.denyWhere((a) => a.source === 'claude', 'task stopped');
    await this.session.stop();
    this.task.status = 'stopped';
    this._save(this.task);
    this._emitTask();
    return true;
  }

  // "I'm back, I'll take over": stop the background run (if any) and hand back the project and the
  // Claude Code conversation so the owner can continue it interactively (claude --resume).
  async takeOver() {
    const task = this.task || this._restoreLastTask();
    if (!task?.sessionId) throw new UserFacingError('There is no coding task to take over yet.');
    const agentName = task.agentName || this.agentName;
    if (agentName !== 'Claude') throw new UserFacingError(`That task ran on ${agentName}, which can't be continued in Claude Code. Start it again with Claude.`);
    if (this.session && !this.session.exited) await this.stop();
    return { project: task.project, path: task.path, sessionId: task.sessionId };
  }

  async shutdown() {
    if (this.session && !this.session.exited) await this.stop();
    this.narrator?.dispose();
  }

  status() {
    if (!this.task) return { active: false };
    const { id, project, instruction, status, startedAt, summary, allowEdits } = this.task;
    return { active: true, agent: this.task.agentName || this.agentName, id, project, instruction, status, startedAt, summary, allowEdits, recent: this.task.updates.slice(-5).map((u) => u.text) };
  }

  _restoreLastTask() {
    const last = this.memory.lastTask();
    if (!last?.sessionId || !last.path) return null;
    this.task = { ...last, updates: [], allowEdits: false };
    return this.task;
  }

  _openSession(task, resumeSessionId) {
    this.narrator?.dispose();
    this.stopping = false;
    this.narrator = new Narrator({
      intervalMs: this.narratorIntervalMs,
      agentName: task.agentName || this.agentName,
      onFeed: (text) => {
        task.updates = [...task.updates, { at: new Date().toISOString(), text }].slice(-50);
        this.emit('feed', { taskId: task.id, text });
      },
      onSpeak: (text) => this.emit('speak', text),
    });
    const session = this.createSession({ cwd: task.path, resumeSessionId, agent: task.agent || null, onPermission: (req) => this._onPermission(task, req) });
    this.session = session;
    session.on('event', (event) => this._onEvent(task, session, event));
  }

  _onEvent(task, session, event) {
    if (session !== this.session) return;
    this.emit('event', { taskId: task.id, event });
    if (event.kind === 'init' && event.sessionId) {
      task.sessionId = event.sessionId;
      this._save(task);
    }
    if (event.kind === 'result') {
      if (this.stopping) return;
      task.status = event.isError ? 'failed' : 'done';
      task.summary = event.text;
      if (event.sessionId) task.sessionId = event.sessionId;
      this._save(task);
      this._emitTask();
    }
    if (event.kind === 'exit') {
      if (this.stopping) return;
      if (task.status === 'running') task.status = 'failed';
      this._save(task);
      this._emitTask();
    }
    this.narrator.push(event);
  }

  async _onPermission(task, { toolName, input, description }) {
    const tier = classifyClaudeTool(toolName, input, task.path);
    if (tier === 'low') return { allow: true };
    if (tier === 'medium' && task.allowEdits && EDIT_TOOLS.has(toolName)) return { allow: true };
    // "Always allow" categories: edits inside the project and ordinary commands (high-risk ones never).
    const category = EDIT_TOOLS.has(toolName) ? 'files' : /^(Bash|PowerShell)$/.test(toolName) ? 'commands' : null;
    const allow = await this.approvals.request({ title: permissionTitle(toolName, input, task.agentName || this.agentName), detail: description || '', tier, source: 'claude', category, grantable: Boolean(category) && tier === 'medium' });
    return allow ? { allow: true } : { allow: false, message: 'The user denied this action. Do not retry it; continue without it or explain what you need.' };
  }

  _closeSession() {
    if (this.session && !this.session.exited) this.session.close();
    this.narrator?.dispose();
  }

  _persistable(task) {
    const { updates, allowEdits, ...rest } = task;
    return rest;
  }

  _save(task) {
    this.memory.updateTask(task.id, this._persistable(task));
  }

  _emitTask() {
    this.emit('task', this.status());
  }
}
