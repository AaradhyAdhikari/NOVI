import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookHandler } from '../../plugins/claude-link/hooks.js';

// Every Claude Code session's questions through Novi (user, 2026-10-29): permission prompts and
// multiple-choice questions become Novi cards (2 min, then Claude's own window asks), "waiting" and
// "finished" are said out loud, and "what's the update?" covers every session.
function mk({ answer = { allow: true } } = {}) {
  const asked = [];
  const said = [];
  const notices = [];
  const worked = [];
  const ask = async (card) => { asked.push(card); return typeof answer === 'function' ? answer(card) : answer; };
  const handle = createHookHandler({ ask, say: (text) => said.push(text), notice: (n) => notices.push(n), worked: (cwd, card) => { worked.push(cwd); notices.push(card); }, now: () => 1000 });
  return { asked, said, notices, worked, handle };
}
const base = { session_id: 's1', cwd: 'C:\\dev\\NOVI', transcript_path: '' };

describe('Claude Code hooks → Novi', () => {
  it('a permission prompt becomes a 2-minute card; yes allows it', async () => {
    const h = mk();
    const out = await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(h.asked[0]).toMatchObject({ title: 'Claude (NOVI) wants to run a command: Run the tests', timeoutMs: 120_000, tier: 'medium', source: 'claude' });
  });

  it('no → Claude is told the user said no; no answer in 2 minutes → Claude\'s own window asks', async () => {
    const no = mk({ answer: { allow: false } });
    expect((await no.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'C:\\dev\\NOVI\\a.js' } })).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'The user said no on Novi.' });
    const quiet = mk({ answer: { allow: false, timedOut: true } });
    expect(await quiet.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'C:\\dev\\NOVI\\a.js' } })).toEqual({});
  });

  it('a risky command needs the high-risk card (voice PIN)', async () => {
    const h = mk();
    await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
    expect(h.asked[0].tier).toBe('high');
  });

  it('a tool that only looks gets no card, in any session', async () => {
    const h = mk();
    const out = await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'mcp__plugin_claude-mem_mcp-search__search', tool_input: { query: 'x' } });
    expect(h.asked).toHaveLength(0);
    expect(out.hookSpecificOutput.decision.behavior).toBe('allow');
  });

  it('Claude\'s plan is a plan card', async () => {
    const h = mk();
    await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '1. Add the hook\n2. Test it' } });
    expect(h.asked[0]).toMatchObject({ title: "Claude's plan for NOVI is ready", detail: '1. Add the hook\n2. Test it', prompt: "Claude's plan for NOVI: 2 steps. Go ahead?" });
    expect(h.asked[0].plan.steps).toEqual(['Add the hook', 'Test it']);
  });

  it('a multiple-choice question is answered on Novi and handed back as answers', async () => {
    const h = mk({ answer: (card) => ({ allow: true, answer: card.question.text.startsWith('Wait') ? '2 minutes' : 'Say both out loud' }) });
    const questions = [
      { question: 'Wait how long?', header: 'Wait', multiSelect: false, options: [{ label: '10 minutes', description: 'a' }, { label: '2 minutes', description: 'b' }] },
      { question: 'Updates how?', header: 'Updates', multiSelect: false, options: [{ label: 'Say both out loud', description: 'c' }] },
    ];
    const out = await h.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers: { 'Wait how long?': '2 minutes', 'Updates how?': 'Say both out loud' } } } });
    expect(h.asked[0].question).toEqual({ text: 'Wait how long?', options: questions[0].options, multiSelect: false });
    expect(h.asked[0].title).toBe('Claude (NOVI) asks: Wait how long?');
  });

  it('a question not answered on Novi goes back to Claude\'s window (and no double card from PermissionRequest)', async () => {
    const h = mk({ answer: { allow: false, timedOut: true } });
    expect(await h.handle({ ...base, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', options: [] }] } })).toEqual({});
    expect(await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: {} })).toEqual({});
    expect(h.asked.length).toBe(1);
  });

  it('"waiting" and "finished" are said out loud; a permission notification adds nothing (the card says it)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-hooks-'));
    const transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All 1700 tests pass. Nothing is committed yet.' }] } }),
    ].join('\n'));
    const h = mk();
    await h.handle({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
    await h.handle({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    await h.handle({ ...base, transcript_path: transcript, hook_event_name: 'Stop' });
    expect(h.said).toEqual(['Claude in NOVI is waiting for you.']);
    // Finished: one small card with one OK, the newest in place of the last (user, 2026-11-05).
    expect(h.notices).toEqual([{ key: 'claude', title: 'Claude finished in NOVI', body: 'All 1700 tests pass.' }]);
    expect(h.handle.updates()).toBe('NOVI: finished — All 1700 tests pass.');
  });

  it('sessions Novi started itself are left alone (their questions already come to Novi)', async () => {
    const h = mk();
    expect(await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, novi_task: true })).toEqual({});
    expect(h.asked).toEqual([]);
  });
});

// Live 2026-11-04: claude-mem's own background sessions said "Claude finished in NOVI: Session Summary…".
describe('background sessions stay quiet', () => {
  const observer = { session_id: 'o1', cwd: 'C:/dev/NOVI', transcript_path: 'C:/Users/A/.claude/projects/C--Users-A--claude-mem-observer-sessions/o1.jsonl' };
  it('a claude-mem observer says nothing and asks nothing', async () => {
    const h = mk();
    await h.handle({ ...observer, hook_event_name: 'Stop' });
    await h.handle({ ...observer, hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(await h.handle({ ...observer, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({});
    await h.handle({ session_id: 'o2', cwd: 'C:/Users/A/.claude-mem/observer-sessions/3', hook_event_name: 'Stop' });
    expect(h.said).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.handle.updates()).toBe('');
  });
});

// User, 2026-11-05: "i dont want it repeatative".
describe('only real work makes a finished card', () => {
  const finished = async (rows) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-hooks-'));
    const transcript_path = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript_path, rows.map((r) => JSON.stringify(r)).join('\n'));
    const h = mk();
    await h.handle({ ...base, transcript_path, hook_event_name: 'Stop' });
    return h;
  };
  const asked = (text) => ({ type: 'user', message: { role: 'user', content: text } });
  const replied = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const used = (name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] } });
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };

  it('a plain answer makes no card, but still counts for "what is the update"', async () => {
    const h = await finished([asked('what is next?'), replied('Fix the freezes next.')]);
    expect(h.notices).toEqual([]);
    expect(h.worked).toEqual([]);
    expect(h.handle.updates()).toBe('NOVI: finished — Fix the freezes next.');
  });
  it('only reading files makes no card', async () => {
    const h = await finished([asked('look at it'), used('Read'), result, used('Grep'), result, replied('It looks fine.')]);
    expect(h.notices).toEqual([]);
  });
  it('changing files or running commands does', async () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'PowerShell']) {
      const h = await finished([asked('fix it'), used(tool), result, replied('Fixed it.')]);
      expect(h.notices.length, tool).toBe(1);
      expect(h.worked, tool).toEqual(['C:\\dev\\NOVI']); // the commit card comes by itself
    }
  });
  it('work from an earlier request does not count for this one', async () => {
    const h = await finished([asked('fix it'), used('Edit'), result, replied('Fixed it.'), asked('thanks'), replied('You are welcome.')]);
    expect(h.notices).toEqual([]);
  });
  it('no transcript to read: the card still comes, better than missing a finish', async () => {
    const h = mk();
    await h.handle({ ...base, transcript_path: 'C:/nope/missing.jsonl', hook_event_name: 'Stop' });
    expect(h.notices).toEqual([{ key: 'claude', title: 'Claude finished in NOVI', body: '' }]);
  });
});

describe('one card, not two', () => {
  it('the finished card goes to whoever decides, not straight to the screen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-hooks-'));
    const transcript_path = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript_path, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done it all.' }] } }),
    ].join('\n'));
    const notices = [];
    const decided = [];
    const handle = createHookHandler({ ask: async () => ({}), say: () => {}, notice: (n) => notices.push(n), worked: (cwd, card) => decided.push(card) });
    await handle({ ...base, transcript_path, hook_event_name: 'Stop' });
    expect(notices).toEqual([]);
    expect(decided).toEqual([{ key: 'claude', title: 'Claude finished in NOVI', body: 'Done it all.' }]);
  });
  it('with nobody to decide, the small card shows', async () => {
    const notices = [];
    const handle = createHookHandler({ ask: async () => ({}), say: () => {}, notice: (n) => notices.push(n) });
    await handle({ ...base, transcript_path: 'C:/nope/x.jsonl', hook_event_name: 'Stop' });
    expect(notices.length).toBe(1);
  });
});

// Live 2026-11-11: two questions in one AskUserQuestion, a paragraph typed under "Other": each card waited
// 2 minutes on its own while the hook as a whole was cut at ~2 minutes, so the answers came too late.
describe('several questions share one longer wait', () => {
  it('the second card only gets the time that is left, and questions get 5 minutes in all', async () => {
    let t = 0;
    const asked = [];
    const ask = async (card) => { asked.push(card); t += 100_000; return { allow: true, answer: 'my long answer' }; };
    const handle = createHookHandler({ ask, say: () => {}, notice: () => {}, now: () => t });
    const out = await handle({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: 'C:/dev/NOVI', tool_input: { questions: [{ question: 'A?', options: [] }, { question: 'B?', options: [] }] } });
    expect(asked[0].timeoutMs).toBe(300_000);
    expect(asked[1].timeoutMs).toBe(200_000);
    expect(out.hookSpecificOutput.updatedInput.answers).toEqual({ 'A?': 'my long answer', 'B?': 'my long answer' });
  });
  it('the hook client waits a little longer than that for questions, 2 minutes for the rest', async () => {
    const { answerWaitMs } = await import('../../tools/claude-hook.mjs');
    expect(answerWaitMs({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' })).toBe(305_000);
    expect(answerWaitMs({ hook_event_name: 'PermissionRequest' })).toBe(125_000);
  });
});
