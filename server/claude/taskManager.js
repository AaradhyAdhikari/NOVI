import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { classifyClaudeTool, EDIT_TOOLS } from '../permissions.js';
import { Narrator } from '../narrator.js';
import { UserFacingError } from '../errors.js';
import { spokenQuestion } from './questions.js';

const SKIPPED = 'The user skipped this question; choose sensibly and say what you chose.';

const fileName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const words = (text, max) => { const w = String(text).trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').split(' '); return w.slice(0, max).join(' '); };

// What the card says and what Novi says aloud for one of the coder's permission requests: what it is
// for, in a few words (Claude's own description of a command, or the file's name). The command or
// full path stays on the card, folded away — nobody wants a 20-line command read out (2026-10-17).
export function claudeAsk(toolName, input = {}, description = '', agentName = 'Claude') {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(input.command || '');
    if (description) {
      const what = words(description, 12);
      return { title: `${agentName} wants to run a command: ${what}`, prompt: `${agentName} wants to ${what.charAt(0).toLowerCase()}${what.slice(1)}.`, detail: command };
    }
    if (!command.includes('\n') && command.length <= 40) return { title: `${agentName} wants to run: ${command}`, prompt: `${agentName} wants to run ${command}.`, detail: '' };
    return { title: `${agentName} wants to run a command`, prompt: `${agentName} wants to run a command.`, detail: command };
  }
  const target = input.file_path || input.notebook_path;
  if (target && (toolName === 'Write' || EDIT_TOOLS.has(toolName))) {
    const verb = toolName === 'Write' ? 'write' : 'edit';
    return { title: `${agentName} wants to ${verb} ${fileName(target)}`, prompt: `${agentName} wants to ${verb} ${fileName(target)}.`, detail: String(target) };
  }
  return { title: permissionTitle(toolName, input, agentName), prompt: '', detail: description || '' };
}

export function permissionTitle(toolName, input = {}, agentName = 'Claude') {
  if (toolName === 'Bash' || toolName === 'PowerShell') return `${agentName} wants to run: ${input.command}`;
  if (toolName === 'Write') return `${agentName} wants to create/overwrite ${input.file_path}`;
  if (EDIT_TOOLS.has(toolName)) return `${agentName} wants to edit ${input.file_path || input.notebook_path}`;
  return `${agentName} wants to use ${toolName}`;
}

export class TaskManager extends EventEmitter {
  constructor({ memory, approvals, createSession, agentName = 'Claude', agentLabels = {}, narratorIntervalMs = 8000, questionReminderMs = 5 * 60_000 }) {
    super();
    this.questionReminderMs = questionReminderMs;
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

  // planFirst (2026-10-18): Claude Code starts in plan mode, so its plan comes to the user as a card
  // first (_planCard); false when the user already approved a brief.
  start(projectName, instruction, { agent, planFirst = true } = {}) {
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
      planFirst: Boolean(planFirst) && agent !== 'novi-coder' && (this.agentLabels[agent] || this.agentName) !== 'Novi Coder',
    };
    this.task = task;
    this.memory.touchProject(project.name);
    this.memory.addTask(this._persistable(task));
    this._openSession(task, null, { permissionMode: task.planFirst ? 'plan' : undefined });
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
    return { active: true, agent: this.task.agentName || this.agentName, id, project, path: this.task.path, instruction, status, startedAt, summary, allowEdits, recent: this.task.updates.slice(-5).map((u) => u.text), plan: this.task.plan || [], files: this.task.files || [] };
  }

  _restoreLastTask() {
    const last = this.memory.lastTask();
    if (!last?.sessionId || !last.path) return null;
    this.task = { ...last, updates: [], allowEdits: false };
    return this.task;
  }

  _openSession(task, resumeSessionId, { permissionMode } = {}) {
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
    const session = this.createSession({ cwd: task.path, resumeSessionId, agent: task.agent || null, ...(permissionMode ? { permissionMode } : {}), onPermission: (req) => this._onPermission(task, req) });
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
    // The coder's plan (Claude's TodoWrite) and the files it wrote: "what's next", "show me the code".
    // Kept for the screen and for "what's the progress"; steps are no longer read out (2026-10-18).
    if (event.kind === 'tool_use' && event.name === 'TodoWrite' && Array.isArray(event.input?.todos)) {
      task.plan = event.input.todos.map((t) => ({ step: String(t.content || ''), doing: String(t.activeForm || t.content || ''), status: t.status || 'pending' }));
    }
    if (event.kind === 'tool_use' && EDIT_TOOLS.has(event.name) && event.input?.file_path) {
      task.files = [...(task.files || []).filter((f) => f !== event.input.file_path), event.input.file_path].slice(-20);
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
    if (toolName === 'AskUserQuestion') return this._askQuestions(input);
    if (toolName === 'ExitPlanMode') return this._planCard(task, input);
    const tier = classifyClaudeTool(toolName, input, task.path);
    if (tier === 'low') return { allow: true };
    if (tier === 'medium' && task.allowEdits && EDIT_TOOLS.has(toolName)) return { allow: true };
    // The user's decision (2026-10-18, "it's asking too many questions"): one yes for the plan, then
    // edits inside the project run at once too (a feed line shows each); outside the project asks.
    if (tier === 'medium' && EDIT_TOOLS.has(toolName)) {
      this.approvals.emit?.('auto_allowed', { category: 'files', title: claudeAsk(toolName, input, description, task.agentName || this.agentName).title });
      return { allow: true };
    }
    // The user's decision (2026-10-17): the coder's ordinary terminal commands run without asking,
    // in every project (a feed line still shows each one). Risky ones (HIGH_RISK_COMMANDS) ask.
    if (tier === 'medium' && /^(Bash|PowerShell)$/.test(toolName)) {
      this.approvals.emit?.('auto_allowed', { category: 'commands', title: claudeAsk(toolName, input, description, task.agentName || this.agentName).title });
      return { allow: true };
    }
    // "Always allow" categories: edits inside the project and ordinary commands (high-risk ones never).
    const category = EDIT_TOOLS.has(toolName) ? 'files' : /^(Bash|PowerShell)$/.test(toolName) ? 'commands' : null;
    const ask = claudeAsk(toolName, input, description, task.agentName || this.agentName);
    // Answerable like every Claude card (user's plan, 2026-10-28): "change X" = no, do X instead;
    // "yes, but X" = yes, and Claude is told X right away.
    const d = await this.approvals.decide({ title: ask.title, detail: ask.detail, ...(ask.prompt ? { prompt: ask.prompt } : {}), tier, source: 'claude', category, grantable: Boolean(category) && tier === 'medium', changeable: true, addable: true });
    if (d.allow) {
      if (d.addition) this.session?.send(`About that last step, the user says: ${String(d.addition).replace(/[.!]+$/, '')}.`);
      return { allow: true };
    }
    if (d.change) return { allow: false, message: `The user said no to this and wants this instead: ${String(d.change).replace(/[.!]+$/, '')}.` };
    return { allow: false, message: 'The user denied this action. Do not retry it; continue without it or explain what you need.' };
  }

  // Claude's plan (plan mode's ExitPlanMode) as a card + a short spoken line. Yes → it builds
  // (edits allowed; "yes, also X" adds X); "change X" → it plans again; no → it stops.
  async _planCard(task, input = {}) {
    const plan = String(input.plan || '').trim();
    const steps = plan.split('\n').map((l) => /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(l)?.[1]?.trim()).filter(Boolean);
    // Said short (user, 2026-10-28: "it read everything — make it short"); the steps are on the card.
    const said = steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : 'the plan is on the card';
    const name = task.agentName || this.agentName;
    const d = await this.approvals.decide({
      title: `${name}'s plan for ${task.project}`, detail: plan, prompt: `${name}'s plan for ${task.project} is ready: ${said}. Go ahead?`,
      tier: 'medium', source: 'claude', changeable: true, addable: true, grantable: false, timeoutMs: 30 * 60_000,
    });
    if (d.allow) {
      task.allowEdits = true;
      if (d.addition) this.session?.send(`Also: ${d.addition}`);
      this._emitTask();
      return { allow: true };
    }
    if (d.change) return { allow: false, message: `The user wants changes to the plan: ${d.change}. Make a new plan with that and show it again with ExitPlanMode.` };
    return { allow: false, message: 'The user said no to this plan. Stop here and do not make changes.' };
  }


  // Claude's own questions: asked one by one as question cards (spoken with numbered options), no
  // timeout — Claude waits; one spoken reminder. A skipped question lets Claude choose.
  async _askQuestions(input = {}) {
    const answers = {};
    for (const q of input.questions || []) {
      if (this.stopping) { answers[q.question] = SKIPPED; continue; } // the task is being stopped: ask nothing more
      const reminder = setTimeout(() => this.emit('speak', `Claude is still waiting: ${String(q.question).replace(/[?.!]+$/, '')}?`), this.questionReminderMs);
      try {
        const decision = await this.approvals.decide({
          title: `Claude asks: ${q.question}`, tier: 'medium', source: 'claude', prompt: spokenQuestion(q),
          question: { text: q.question, options: q.options || [], multiSelect: Boolean(q.multiSelect) }, timeoutMs: null,
        });
        answers[q.question] = decision.allow && decision.answer ? decision.answer : SKIPPED;
      } finally {
        clearTimeout(reminder);
      }
    }
    return { allow: true, updatedInput: { ...input, answers } };
  }

  // Close the (finished) coder session in a project so Windows lets the folder be renamed or moved.
  release(projectName) {
    if (!this.task || this.task.project !== projectName || this.task.status === 'running') return false;
    this._closeSession();
    this.task = null;
    return true;
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
