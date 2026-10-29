import fs from 'node:fs';
import path from 'node:path';
import { classifyClaudeTool } from '../../server/permissions.js';
import { claudeAsk } from '../../server/claude/taskManager.js';

// Every Claude Code session on the laptop asks through Novi (user, 2026-10-29: "every claude questions of
// every session and every project … through novi"): Claude Code's hooks (tools/claude-hook.mjs) post
// here. Permission prompts and multiple-choice questions become Novi cards; a card not answered in 2
// minutes gives "no decision", so Claude's own window asks as before (user's choice). "Waiting" and
// "finished" are said out loud (user's choice), and every session's last state feeds "what's the update?".
// Sessions Novi started itself already send their questions to Novi: the hook script marks them.

const WAIT_MS = 120_000;
const said = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const firstSentence = (text) => {
  const t = said(text).replace(/[*_`#>]/g, '');
  const m = /^(.{8,160}?[.!?])(?:\s|$)/.exec(t);
  return m ? m[1] : t.slice(0, 120);
};
const projectOf = (cwd) => path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || 'a project';

// The last thing Claude said in this session (end of its transcript).
function lastReply(file) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const size = Math.min(st.size, 200_000);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const msg = row?.message;
      if (row?.type !== 'assistant' || msg?.role !== 'assistant') continue;
      const text = Array.isArray(msg.content) ? msg.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ') : String(msg.content || '');
      if (said(text)) return said(text);
    }
  } catch { /* no transcript */ }
  return '';
}

export function createHookHandler({ ask, say, now = Date.now }) {
  const sessions = new Map(); // session_id → { project, state, line, at }
  const note = (h, state, line = '') => sessions.set(h.session_id || h.cwd, { project: projectOf(h.cwd), state, line, at: now() });

  async function permission(h) {
    const project = projectOf(h.cwd);
    const tool = h.tool_name;
    if (tool === 'AskUserQuestion') return {}; // its PreToolUse card already asks
    const input = h.tool_input || {};
    const card = tool === 'ExitPlanMode'
      ? { title: `Claude's plan for ${project} is ready`, prompt: `Claude's plan for ${project} is ready. Go ahead?`, detail: String(input.plan || '') }
      : claudeAsk(tool, input, input.description || '', `Claude (${project})`);
    const tier = classifyClaudeTool(tool, input, h.cwd) === 'high' ? 'high' : 'medium';
    note(h, 'asking', card.title);
    const d = await ask({ ...card, tier, source: 'claude', timeoutMs: WAIT_MS });
    if (d?.timedOut) { note(h, 'waiting', card.title); return {}; }
    note(h, 'working');
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d?.allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user said no on Novi.' } } };
  }

  async function questions(h) {
    const project = projectOf(h.cwd);
    const input = h.tool_input || {};
    const answers = {};
    for (const q of [].concat(input.questions || [])) {
      note(h, 'asking', q.question);
      const d = await ask({
        title: `Claude (${project}) asks: ${q.question}`, tier: 'medium', source: 'claude', timeoutMs: WAIT_MS,
        question: { text: q.question, options: q.options || [], multiSelect: Boolean(q.multiSelect) },
      });
      if (!d?.allow || !d.answer) { note(h, 'waiting', q.question); return {}; } // not answered here: Claude's window asks
      answers[q.question] = d.answer;
    }
    note(h, 'working');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers } } };
  }

  async function handle(h = {}) {
    if (h.novi_task) return {};
    switch (h.hook_event_name) {
      case 'PermissionRequest': return permission(h);
      case 'PreToolUse': return h.tool_name === 'AskUserQuestion' ? questions(h) : {};
      case 'Notification': {
        if (!/idle_prompt|agent_needs_input|elicitation_dialog/.test(String(h.notification_type || ''))) return {};
        note(h, 'waiting', said(h.message));
        say(`Claude in ${projectOf(h.cwd)} is waiting for you.`);
        return {};
      }
      case 'Stop': {
        const line = firstSentence(lastReply(h.transcript_path));
        note(h, 'finished', line);
        say(line ? `Claude finished in ${projectOf(h.cwd)}: ${line}` : `Claude finished in ${projectOf(h.cwd)}.`);
        return {};
      }
      case 'UserPromptSubmit':
      case 'SessionStart':
        note(h, 'working');
        return {};
      default:
        return {};
    }
  }

  // "What's the update?": one line per session heard from in the last 12 hours, newest first.
  handle.updates = () => [...sessions.values()]
    .filter((s) => now() - s.at < 12 * 3600_000)
    .sort((a, b) => b.at - a.at)
    .map((s) => `${s.project}: ${s.state}${s.line ? ` — ${s.line}` : ''}`)
    .join('\n');
  return handle;
}
