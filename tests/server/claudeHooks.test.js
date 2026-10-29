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
  const ask = async (card) => { asked.push(card); return typeof answer === 'function' ? answer(card) : answer; };
  const handle = createHookHandler({ ask, say: (text) => said.push(text), now: () => 1000 });
  return { asked, said, handle };
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

  it('Claude\'s plan is a plan card', async () => {
    const h = mk();
    await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '1. Add the hook\n2. Test it' } });
    expect(h.asked[0]).toMatchObject({ title: "Claude's plan for NOVI is ready", detail: '1. Add the hook\n2. Test it' });
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
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All 1700 tests pass. Nothing is committed yet.' }] } }),
    ].join('\n'));
    const h = mk();
    await h.handle({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
    await h.handle({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    await h.handle({ ...base, transcript_path: transcript, hook_event_name: 'Stop' });
    expect(h.said).toEqual(['Claude in NOVI is waiting for you.', 'Claude finished in NOVI: All 1700 tests pass.']);
    expect(h.handle.updates()).toBe('NOVI: finished — All 1700 tests pass.');
  });

  it('sessions Novi started itself are left alone (their questions already come to Novi)', async () => {
    const h = mk();
    expect(await h.handle({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, novi_task: true })).toEqual({});
    expect(h.asked).toEqual([]);
  });
});
