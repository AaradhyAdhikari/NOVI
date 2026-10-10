import { AllProvidersUnavailableError } from './router.js';
import { selectTools, isQuickTurn, ALWAYS } from './toolSelect.js';
import { classifyApproval } from '../grants.js';
import { UserFacingError } from '../errors.js';
import { firstSentence } from '../narrator.js';

const MAX_ROUNDS = 10; // screen tasks: open the app, look, click, type, …
const MAX_HISTORY = 40;

export function systemPrompt({ projects, task, accounts = [] }) {
  return [
    'You are Novi, a voice-first personal AI companion. Your replies are spoken aloud: answer in 1-2 short, natural sentences (about 25 words), with no markdown, lists, code or links; never offer more help at the end. Details and links only when asked.',
    "You control a coding agent on the user's laptop through tools. For coding work on a project, call code_start_task with the project name and a clear, complete instruction for the coding agent. For follow-ups and changes to the current or most recent task, even while it is running ('make the button blue', 'add dark mode'), call code_send_message. To show code ('show me the HTML'), call code_show. To start a brand-new project, call code_new_project. Use code_status for progress questions and code_stop to stop.",
    'If the user mentions a project you do not know, ask for its folder path, then call remember_project.',
    'You can also act directly: open_website (use a full https URL when you know the site) and play_youtube open things right away on the device the user is using; open_app opens installed apps on the laptop. To watch or play anything ("show me valorant", "play X"), call play_youtube (top result by default; position for "the 5th one"); use youtube_search only when the user asks to see the options. Never read out a list of videos; after playing, just say the title.',
    'To do something inside an app on the laptop that has no tool of its own (e.g. "open Claude and make a project named X"), do it yourself step by step: open_app, then screen_look, screen_click, screen_type and screen_key until it is done. Do not stop after opening the app or tell the user to do it.',
    'Never say you played, opened, sent or did something unless a tool result in this turn says it happened; if you did not call the tool, call it. Never say a task is finished unless a tool result says so. If a tool returns an error, explain it briefly.',
    `Known projects: ${projects.length ? projects.map((p) => `${p.name} (${p.path})`).join('; ') : 'none yet'}.`,
    `Current coding task: ${task.active ? `${task.status} on ${task.project}: "${task.instruction}"` : 'none'}.`,
    'For email use gmail_search (Gmail search syntax), gmail_read and gmail_send; gmail_connect connects a new account. If a tool result contains "ask", ask the user which account and call the tool again with account. Never guess email addresses. Write the complete email before gmail_send; the user approves it on screen. When summarising mail, mention sender and subject briefly.',
    `Connected accounts: ${accounts.length ? accounts.map((a) => `${a.provider === 'github' ? 'GitHub' : 'Gmail'} ${a.label} (${a.email}${a.isDefault ? ', default' : ''}${a.status === 'expired' ? ', expired' : ''})`).join('; ') : 'none'}.`,
  ].join('\n');
}

const CHOICE_RE = /^(?:no[, ]+)?(?:(?:use|with|switch to)\s+)?(?:the\s+)?(claude(?: code)?|novi coder|free one)(?:\s+instead)?(?:[, ]+please)?$/;

// The owner's everyday yes / no / cancel in Hinglish, Hindi and Marathi (Latin or Devanagari: Sarvam
// writes Hindi in Devanagari). Whole reply only: "haan but use cursor" still goes to the brain.
const APPROVE_LOCAL = /^(?:approved|go for it|include kar(?:o|do)?|kar ?le(?: update)?|kar ?lo|kar do|haa?n?(?: kar do| karo)?|theek hai|thik hai|chalega|हाँ|हां|हा|कर दो|कर लो|कर ले|ठीक है|चलेगा|हो|चालेल|कर)$/;
const DENY_LOCAL = /^(?:nahi|nahin|nai|mat kar(?:o)?|rehne de|rehne do|nako|नहीं|नही|मत करो|मत कर|रहने दो|नको)$/;
const STOP_LOCAL = /^(?:cancel (?:kar|karo|it|kar do)|ruk ja|ruko|band kar(?:o)?|बंद करो|बंद कर|रुक जा|रुको|कैंसल कर(?:ो| दो)?|थांब)$/;

// YouTube by voice without the AI: "open YouTube" opens it now and the next answer names the video;
// "play X on YouTube" / "YouTube pe X lagao" plays at once. Returns { open } | { play } | { maybe } | null.
const YT = '(?:youtube|yt|you tube|यूट्यूब)';
const PLAY_VERB = '(?:play|show(?: me)?|put on|watch|search(?: for)?)';
const HI_VERB = '(?:(?:laga|chala|dikha|lagao|chalao|dikhao)(?: do| de)?|play kar(?:o|do| do)?|search kar(?:o)?)';
const OPEN = '(?:open|start|launch|khol(?:o|do|de)?|open kar(?:o|do)?)';
export function youtubeCommand(text, { awaiting = false } = {}) {
  const t = String(text || '').trim().replace(/[.!?।,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:(?:hey )?novi|please) /i, '');
  const hiTail = (q) => q.replace(new RegExp(` ${HI_VERB}$`, 'iu'), '').trim();
  let m = new RegExp(`^(?:${OPEN} ${YT}|${YT} ${OPEN})(?: (?:and|aur|then|and then)(?: ${PLAY_VERB})? (.+))?$`, 'iu').exec(t);
  if (m) return m[1] ? { play: hiTail(m[1]) } : { open: true };
  m = new RegExp(`^${PLAY_VERB} (.+?) (?:on|in) ${YT}$`, 'iu').exec(t)
    || new RegExp(`^${YT} (?:open|khol) ?(?:kar ?ke|ke) (.+?)(?: (?:sunna|sunao|dekhna|dekhni|dekho|${HI_VERB}))?$`, 'iu').exec(t)
    || new RegExp(`^${YT} (?:pe|par|per|on) (.+?) ${HI_VERB}$`, 'iu').exec(t)
    || new RegExp(`^${YT} (?:pe|par|per|on) ${PLAY_VERB} (.+)$`, 'iu').exec(t);
  if (m) return { play: m[1] };
  if (!awaiting || !t) return null;
  m = new RegExp(`^${PLAY_VERB} (.+)$`, 'iu').exec(t) || new RegExp(`^(.+?) ${HI_VERB}$`, 'iu').exec(t);
  return m ? { play: m[1] } : { maybe: t };
}
// "Show my GitHub contributions (yesterday)" → the graph picture, without the AI. "Open my GitHub" is not this.
export function githubGraphCommand(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  if (!/github|गिटहब/.test(t) || !/contri|graph|ss\b|screenshot|photo|picture|कॉन्ट्रि/.test(t)) return null;
  if (/\b(?:open|khol\w*)\b|खोल/.test(t)) return null;
  const d = new Date(now);
  const yesterday = /yesterday|\bkal\b|कल/.test(t);
  if (yesterday) d.setDate(d.getDate() - 1);
  return { date: d.toLocaleDateString('en-CA'), when: yesterday ? 'yesterday' : 'today' };
}

// "Show me the HTML code" / "navbar ka code dikhao" → code_show with the user's words (no AI call).
export function codeCommand(text) {
  const t = String(text || '').trim();
  if (!/\bcode\b|कोड/i.test(t) || !/\b(show|see|dikha\w*|dekh\w*)\b|दिखा/i.test(t)) return null;
  if (/\b(fix|change|add|write|make|remove|delete|update|bana\w*|badal\w*)\b/i.test(t) && !/\b(show|see)\b.*\b(wrote|written|did you)\b|\bdid you write\b/i.test(t)) return null;
  return t;
}

const QUESTION = /^(?:what|whats|what's|how|why|who|when|where|which|is|are|can|could|do|does|kya|kaise|kab|kaun|kahan|kitna)\b/i;

// Short spoken replies Novi handles without calling the AI (stop, yes/no, "use Claude instead", status).
export function quickCommand(text) {
  const t = text.trim().toLowerCase().replace(/[.!?।]+$/, '').replace(/\s+/g, ' ');
  if (/^(stop|cancel|abort|stop it|stop claude|stop the task)$/.test(t) || STOP_LOCAL.test(t)) return 'stop';
  const choice = CHOICE_RE.exec(t);
  if (choice) return choice[1].startsWith('claude') ? 'choose:claude' : 'choose:novi-coder';
  if (/^(?:(?:yes|yeah|ok|okay)[, ]+)?(?:always allow|allow always|always)(?:[, ]+(?:allow )?(?:it|this|that))?(?:[, ]+please)?$/.test(t)) return 'approve-always';
  if (/^(yes|yeah|yep|yup|sure|allow|allow it|approve|go ahead|do it|ok|okay|start|start it)(?:[, ]+(?:please|start|go ahead|do it))?$/.test(t) || APPROVE_LOCAL.test(t)) return 'approve';
  if (/^(no|nope|nah|deny|don't|do not|reject)(?:[, ]+(?:thanks|thank you))?$/.test(t) || DENY_LOCAL.test(t)) return 'deny';
  if (/^(what('s| is) (claude|the coder|novi coder|it) doing|status|progress|what('s| is) the progress|how far( along)?( is it)?|progress kya hai|kitna hua|kaha tak pahuncha|status kya hai)$/.test(t)) return 'status';
  if (/^(what('s| is) next|what('s| is) the next step|next step|aage kya( hai)?|ab kya( hai)?|next kya hai)$/.test(t)) return 'next';
  return null;
}

const lower = (t) => String(t).charAt(0).toLowerCase() + String(t).slice(1).replace(/[.!]+$/, '');

// "What's next": the next step of the coder's plan (null when no task, so the brain answers instead).
export function describeNext(s) {
  if (!s.active) return null;
  const plan = s.plan || [];
  const next = plan.find((p) => p.status === 'pending');
  if (next) return `Next: ${lower(next.step)}.`;
  const doing = plan.find((p) => p.status === 'in_progress');
  if (doing) return `That's the last step: ${lower(doing.doing)}.`;
  if (plan.length) return s.status === 'running' ? 'All planned steps are done; it is finishing up.' : describeStatus(s);
  const latest = (s.recent || []).at(-1);
  return `${s.agent || 'Claude'} hasn't shared a plan yet.${latest ? ` Latest: ${latest}.` : ''}`;
}

export function describeStatus(s) {
  if (!s.active) return 'No coding task is running right now.';
  const who = s.agent || 'Claude';
  if (s.status === 'running') {
    const plan = s.plan || [];
    const at = plan.findIndex((p) => p.status === 'in_progress');
    if (at >= 0) return `Step ${at + 1} of ${plan.length}: ${lower(plan[at].doing)}.`;
    const latest = (s.recent || []).at(-1);
    return `${who} is working on ${s.project}.${latest ? ` Latest: ${latest}.` : ''}`;
  }
  if (s.status === 'done') return `${who} finished the task on ${s.project}. ${firstSentence(s.summary || '')}`.trim();
  if (s.status === 'stopped') return `The task on ${s.project} was stopped.`;
  return `The last task on ${s.project} failed. ${firstSentence(s.summary || '')}`.trim();
}

export class Agent {
  constructor({ router, tools, approvals, memory, tasks, accounts = null, privateProviders = ['groq'], logger = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.sleep = sleep;
    this.logger = logger;
    this.accounts = accounts;
    this.privateProviders = privateProviders;
    this.router = router;
    this.tools = tools;
    this.approvals = approvals;
    this.memory = memory;
    this.tasks = tasks;
    this.history = [];
  }

  // from: 'local' (the laptop) or { deviceId } — approvals answered by voice check it (server/remoteTrust.js).
  async handle(text, { from = 'local' } = {}) {
    const quick = quickCommand(text);
    if (quick) {
      const quickReply = await this._quick(quick, from);
      if (quickReply) return this._remember(text, quickReply);
    }
    const yt = await this._youtube(text);
    if (yt) return this._remember(text, yt);
    const code = this.tools.get('code_show') ? codeCommand(text) : null;
    if (code) {
      const { output } = await this._runTool({ id: `code-${Date.now()}`, function: { name: 'code_show', arguments: JSON.stringify({ what: code }) } });
      return this._remember(text, output?.error || `Here's ${output?.file}.`);
    }
    const gh = this.tools.get('github_graph') ? githubGraphCommand(text) : null;
    if (gh) {
      const { output } = await this._runTool({ id: `gh-${Date.now()}`, function: { name: 'github_graph', arguments: JSON.stringify({ date: gh.date }) } });
      const n = output?.contributions;
      return this._remember(text, output?.error || `You made ${n} contribution${n === 1 ? '' : 's'} ${gh.when}.`);
    }

    const { extra, messages, offered, purpose } = await this._prepare(text);
    const notes = [];
    // Personal context (memories) only goes to providers the user trusts with private data.
    let provider = extra.sensitive ? this.privateProviders[0] : undefined;
    let waited = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let res;
      try {
        res = await this.router.chat({ messages, tools: offered, purpose, only: provider });
      } catch (err) {
        if (!(err instanceof AllProvidersUnavailableError)) throw err;
        // A private turn can't fall back to another provider; a short rate-limit is worth waiting out.
        if (extra.sensitive && !waited && err.retryInMs <= 20_000) {
          waited = true;
          await this.sleep(err.retryInMs);
          round -= 1;
          continue;
        }
        const fallback = notes.length ? notes.join(' ') : `My AI providers are busy right now. Try again in about ${Math.ceil(err.retryInMs / 1000)} seconds.`;
        return this._remember(text, fallback);
      }
      provider = res.provider; // a turn's tool rounds stay on one provider (Gemini thought signatures)
      const calls = res.message.tool_calls || [];
      if (!calls.length) return this._remember(text, (res.message.content || '').trim() || notes.join(' ') || 'Done.');
      messages.push(res.message);
      let sensitive = false;
      for (const call of calls) {
        const result = await this._runTool(call);
        if (result.note) notes.push(result.note);
        if (result.output?.sensitive) sensitive = true;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.output) });
      }
      // Private data (email) only ever goes to providers the user trusts with it.
      if (sensitive && !this.privateProviders.includes(provider)) {
        return this._remember(text, "I can't read your mail right now — my private AI provider is busy. Try again in a minute.");
      }
    }
    return this._remember(text, notes.join(' ') || 'I got stuck working that out. Could you rephrase?');
  }

  // The system prompt, messages and tools for one turn (shared by handle and firstStep).
  async _prepare(text) {
    // Plugins (e.g. long-term memory) add guidance and context for this turn.
    const extra = (await this.tools.promptContext?.({ prompt: text, messages: this.history })) || {};
    const system = [systemPrompt({ projects: this.memory.listProjects(), task: this.tasks.status(), accounts: this._accountsForPrompt() }), extra.system, extra.context].filter(Boolean).join('\n');
    const messages = [
      { role: 'system', content: system },
      ...this.history,
      { role: 'user', content: text },
    ];
    // Only the tools this request needs (keeps each call small enough for free rate limits).
    const taskActive = Boolean(this.tasks.status().active);
    const offered = selectTools(this.tools.schemas(), { text, history: this.history, taskActive });
    const purpose = isQuickTurn(text, offered, { taskActive }) ? 'quick' : 'fast';
    return { extra, messages, offered, purpose };
  }

  // Dry run for tools/understanding-benchmark.mjs: what the brain would do first for `text`
  // (a quick yes/no/cancel, tool calls with their arguments, or a plain reply). Runs nothing and
  // leaves the conversation history alone.
  async firstStep(text) {
    const quick = quickCommand(text);
    if (quick) return { quick, calls: [], reply: null, provider: null };
    const yt = this.tools.get('play_youtube') ? youtubeCommand(text) : null;
    if (yt?.play) return { quick: null, calls: [{ name: 'play_youtube', args: { query: yt.play } }], reply: null, provider: 'direct' };
    const gh = this.tools.get('github_graph') ? githubGraphCommand(text) : null;
    if (gh) return { quick: null, calls: [{ name: 'github_graph', args: { date: gh.date } }], reply: null, provider: 'direct' };
    const { extra, messages, offered, purpose } = await this._prepare(text);
    const res = await this.router.chat({ messages, tools: offered, purpose, only: extra.sensitive ? this.privateProviders[0] : undefined });
    const calls = (res.message.tool_calls || []).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* keep {} */ }
      return { name: c.function?.name, args };
    });
    return { quick: null, calls, reply: calls.length ? null : (res.message.content || '').trim(), provider: res.provider };
  }

  async _youtube(text) {
    if (!this.tools.get('play_youtube') || !this.tools.get('open_website')) return null;
    const awaiting = this._ytUntil > Date.now();
    this._ytUntil = 0;
    const cmd = youtubeCommand(text, { awaiting });
    if (!cmd) return null;
    let query = cmd.play;
    if (cmd.maybe) {
      // Only a plain answer ("valorant") is a video name; anything that needs another tool goes to the brain.
      const offered = selectTools(this.tools.schemas(), { text });
      const plain = offered.every((s) => ALWAYS.has(s.function.name)) && cmd.maybe.split(' ').length <= 8 && !QUESTION.test(cmd.maybe);
      if (!plain) return null;
      query = cmd.maybe;
    }
    const run = (name, args) => this._runTool({ id: `yt-${Date.now()}`, function: { name, arguments: JSON.stringify(args) } });
    if (cmd.open) {
      const { output } = await run('open_website', { target: 'https://www.youtube.com' });
      if (output?.error) return output.error;
      this._ytUntil = Date.now() + 2 * 60_000;
      return output?.on === 'phone' ? "Here's YouTube. What should I play?" : "YouTube's open. What should I play?";
    }
    const { output } = await run('play_youtube', { query });
    if (output?.error) return output.error;
    if (output?.note) return output.note;
    return `Playing ${output?.playing?.title || query}.`;
  }

  async _quick(kind, from = 'local') {
    if (kind === 'stop') {
      // While Novi is asking something, "cancel" answers that question; it doesn't stop the task.
      const asking = this.approvals.latest({ excludeTier: 'high' });
      if (asking) {
        this.approvals.resolve(asking.id, false, 'voice', null, { from });
        return 'Okay, cancelled.';
      }
      return (await this.tasks.stop()) ? 'Okay, I stopped the coding task.' : 'Nothing is running right now.';
    }
    if (kind === 'status') return describeStatus(this.tasks.status());
    if (kind === 'next') return describeNext(this.tasks.status());
    if (kind.startsWith('choose:')) {
      const choice = kind.slice('choose:'.length);
      const open = this.approvals.pending().filter((a) => a.tier !== 'high' && !a.kind && a.choices);
      const withChoice = open.filter((a) => a.choices.some((c) => c.id === choice)).at(-1);
      const label = choice === 'claude' ? 'Claude Code' : 'Novi Coder';
      if (withChoice) {
        this.approvals.resolve(withChoice.id, true, 'voice', choice, { from });
        return `Okay, using ${label}.`;
      }
      // Picking the option Novi already proposed is just a yes.
      if (open.length) {
        this.approvals.resolve(open.at(-1).id, true, 'voice', null, { from });
        return `Okay, using ${label}.`;
      }
      return null;
    }
    const item = this.approvals.latest({ excludeTier: 'high' });
    if (!item) {
      const pending = this.approvals.pending();
      if (!pending.length) return null;
      return pending.some((a) => a.kind) ? 'That one deletes or pays for something, so please confirm it on screen.' : 'That one is high risk, so please confirm it on screen.';
    }
    if (kind === 'approve-always') {
      if (!item.grant) {
        this.approvals.resolve(item.id, true, 'voice', null, { from });
        return "Approved. I can't remember that kind of action, so I'll ask each time.";
      }
      this.approvals.resolve(item.id, true, 'voice', null, { always: true, from });
      return `Approved. I'll always allow ${item.grant.label} from now on.`;
    }
    const allow = kind === 'approve';
    this.approvals.resolve(item.id, allow, 'voice', null, { from });
    return allow ? 'Approved.' : 'Okay, denied.';
  }

  // One log line per tool run (name + ok or the error; never the arguments, which can be private).
  async _runTool(call) {
    const result = await this._runToolInner(call);
    const err = result.output?.error;
    this.logger?.log?.(`[tool] ${call.function?.name} ${err ? `error: ${String(err).slice(0, 200)}` : 'ok'}`);
    return result;
  }

  async _runToolInner(call) {
    const tool = this.tools.get(call.function?.name);
    if (!tool) return { output: { error: `Unknown tool ${call.function?.name}` } };
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { output: { error: 'Arguments were not valid JSON' } };
    }
    // "$"-prefixed arguments are reserved for choices the user makes (e.g. "use Claude instead"); never from the model.
    for (const key of Object.keys(args)) if (key.startsWith('$')) delete args[key];
    if (tool.gate) {
      // Plugin tools: approval and blocking come from before_tool_call hooks (OpenClaw shape).
      const gate = await tool.gate(args, { toolCallId: call.id });
      if (gate.block) return { output: { error: gate.blockReason, ...(gate.details || {}) }, note: gate.blockReason };
      if (gate.approval) {
        const { title, detail, tier, prompt, choices } = gate.approval;
        // Which kind of action this is, and whether "always allow" may apply (never for sends/deletes/high risk).
        const { category, grantable } = classifyApproval({ toolName: tool.name, pluginId: tool.pluginId, tier, choices, category: gate.approval.category, grantable: gate.approval.grantable });
        const decision = await this.approvals.decide({
          title, detail: detail || '', tier, source: 'novi', prompt,
          choices: choices?.map(({ id, label }) => ({ id, label })),
          category, grantable, ...(gate.approval.kind ? { kind: gate.approval.kind } : {}),
        });
        if (!decision.allow) return { output: { error: 'The user declined this action.' } };
        const picked = decision.choice && choices?.find((c) => c.id === decision.choice);
        if (picked?.params) Object.assign(args, picked.params);
      }
    } else {
      if (tool.precheck) {
        const pre = await tool.precheck(args);
        if (pre) return { output: pre, note: pre.note };
      }
      if (tool.tier !== 'low') {
        const allowed = await this.approvals.request({ title: tool.describe(args), detail: tool.detail ? tool.detail(args) : '', tier: tool.tier, source: 'novi' });
        if (!allowed) return { output: { error: 'The user declined this action.' } };
      }
    }
    try {
      const output = await tool.run(args, { toolCallId: call.id });
      return { output, note: output?.note };
    } catch (err) {
      return { output: { error: err.message }, note: err instanceof UserFacingError ? err.message : undefined };
    }
  }

  _accountsForPrompt() {
    if (!this.accounts) return [];
    return this.accounts.list().map((a) => ({ ...a, isDefault: this.accounts.defaultFor(a.provider)?.id === a.id }));
  }

  _remember(text, replyText) {
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: replyText });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    Promise.resolve(this.tools.agentEnd?.({ messages: [{ role: 'user', content: text }, { role: 'assistant', content: replyText }], success: true })).catch(() => {});
    return replyText;
  }
}
