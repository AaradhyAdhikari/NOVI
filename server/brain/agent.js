import { AllProvidersUnavailableError } from './router.js';
import { UserFacingError } from '../errors.js';
import { firstSentence } from '../narrator.js';

const MAX_ROUNDS = 6;
const MAX_HISTORY = 40;

export function systemPrompt({ projects, task }) {
  return [
    'You are Novi, a voice-first personal AI companion. Your replies are spoken aloud: answer in 1-3 short, natural sentences, with no markdown, lists or code.',
    "You control a coding agent on the user's laptop through tools. For coding work on a project, call code_start_task with the project name and a clear, complete instruction for the coding agent. For follow-ups to the current or most recent task, call code_send_message. Use code_status for progress questions and code_stop to stop.",
    'If the user mentions a project you do not know, ask for its folder path, then call remember_project.',
    'You can also act on the laptop directly: open_website (use a full https URL when you know the site), youtube_search to list videos, play_youtube to play one (it plays the top result by default; pass position for "the 5th one", and omit query to pick from the last search), and open_app for installed apps. These open things on the laptop right away. After youtube_search, read out the top 5 results as "1, title, by channel" so the user can pick one by number.',
    'Never say a task is finished unless a tool result says so. If a tool returns an error, explain it briefly.',
    `Known projects: ${projects.length ? projects.map((p) => `${p.name} (${p.path})`).join('; ') : 'none yet'}.`,
    `Current coding task: ${task.active ? `${task.status} on ${task.project}: "${task.instruction}"` : 'none'}.`,
  ].join('\n');
}

export function quickCommand(text) {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (/^(stop|cancel|abort|stop it|stop claude|stop the task)$/.test(t)) return 'stop';
  if (/^(yes|yeah|yep|allow|allow it|approve|go ahead|do it|ok|okay)$/.test(t)) return 'approve';
  if (/^(no|nope|deny|don't|do not|reject)$/.test(t)) return 'deny';
  if (/^(what('s| is) (claude|the coder|novi coder|it) doing|status|what('s| is) the progress)$/.test(t)) return 'status';
  return null;
}

export function describeStatus(s) {
  if (!s.active) return 'No coding task is running right now.';
  const who = s.agent || 'Claude';
  if (s.status === 'running') {
    const recent = (s.recent || []).slice(-2).join(', then ');
    return `${who} is working on ${s.project}.${recent ? ` Latest: ${recent}.` : ''}`;
  }
  if (s.status === 'done') return `${who} finished the task on ${s.project}. ${firstSentence(s.summary || '')}`.trim();
  if (s.status === 'stopped') return `The task on ${s.project} was stopped.`;
  return `The last task on ${s.project} failed. ${firstSentence(s.summary || '')}`.trim();
}

export class Agent {
  constructor({ router, tools, approvals, memory, tasks }) {
    this.router = router;
    this.tools = tools;
    this.approvals = approvals;
    this.memory = memory;
    this.tasks = tasks;
    this.history = [];
  }

  async handle(text) {
    const quick = quickCommand(text);
    if (quick) {
      const quickReply = await this._quick(quick);
      if (quickReply) return this._remember(text, quickReply);
    }

    const messages = [
      { role: 'system', content: systemPrompt({ projects: this.memory.listProjects(), task: this.tasks.status() }) },
      ...this.history,
      { role: 'user', content: text },
    ];
    const notes = [];
    let provider;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let res;
      try {
        res = await this.router.chat({ messages, tools: this.tools.schemas(), purpose: 'fast', only: provider });
      } catch (err) {
        if (!(err instanceof AllProvidersUnavailableError)) throw err;
        const fallback = notes.length ? notes.join(' ') : `My AI providers are busy right now. Try again in about ${Math.ceil(err.retryInMs / 1000)} seconds.`;
        return this._remember(text, fallback);
      }
      provider = res.provider; // a turn's tool rounds stay on one provider (Gemini thought signatures)
      const calls = res.message.tool_calls || [];
      if (!calls.length) return this._remember(text, (res.message.content || '').trim() || notes.join(' ') || 'Done.');
      messages.push(res.message);
      for (const call of calls) {
        const result = await this._runTool(call);
        if (result.note) notes.push(result.note);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.output) });
      }
    }
    return this._remember(text, notes.join(' ') || 'I got stuck working that out. Could you rephrase?');
  }

  async _quick(kind) {
    if (kind === 'stop') return (await this.tasks.stop()) ? 'Okay, I stopped the coding task.' : 'Nothing is running right now.';
    if (kind === 'status') return describeStatus(this.tasks.status());
    const item = this.approvals.latest({ excludeTier: 'high' });
    if (!item) return this.approvals.pending().length ? 'That one is high risk, so please confirm it on screen.' : null;
    const allow = kind === 'approve';
    this.approvals.resolve(item.id, allow, 'voice');
    return allow ? 'Approved.' : 'Okay, denied.';
  }

  async _runTool(call) {
    const tool = this.tools.get(call.function?.name);
    if (!tool) return { output: { error: `Unknown tool ${call.function?.name}` } };
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { output: { error: 'Arguments were not valid JSON' } };
    }
    if (tool.tier !== 'low') {
      const allowed = await this.approvals.request({ title: tool.describe(args), tier: tool.tier, source: 'novi' });
      if (!allowed) return { output: { error: 'The user declined this action.' } };
    }
    try {
      const output = await tool.run(args);
      return { output, note: output?.note };
    } catch (err) {
      return { output: { error: err.message }, note: err instanceof UserFacingError ? err.message : undefined };
    }
  }

  _remember(text, replyText) {
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: replyText });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    return replyText;
  }
}
