import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookHandler } from '../../plugins/claude-link/hooks.js';
import { waitsForAnswer } from '../../tools/claude-hook.mjs';

// Live 2026-11-07: "why this approval never came to my phone? make every request of u come to me through
// novi". The Claude app's next-step box (mcp__ccd_turn__wrap_up) isn't a hook event, so Novi never saw it.
const asked = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'shown' }] } });
const wrapUp = (input, id = 'w1') => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input }] } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const edited = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: {} }] } });

function transcript(...rows) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'next-step-')), 's.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  return file;
}
function mk(answer = { allow: true, answer: 'Yes, build it' }) {
  const cards = [];
  const worked = [];
  const handle = createHookHandler({
    ask: async (c) => { cards.push(c); return answer; }, say: () => {}, notice: () => {}, worked: (cwd, c) => worked.push(c),
  });
  return { cards, worked, handle, stop: (transcript_path, extra = {}) => handle({ session_id: 's', cwd: 'C:\\dev\\NOVI', transcript_path, hook_event_name: 'Stop', ...extra }) };
}
const ASK = { recap: 'Done.', ask: 'Should I start building per-app tone?', actions: [{ label: 'Yes, build it' }, { label: 'Not now' }] };

describe("Claude's next-step question reaches the phone", () => {
  it('becomes a question card with its buttons, for 2 minutes', async () => {
    const h = mk();
    await h.stop(transcript(asked('whats next'), wrapUp(ASK), result(), said('Next is per-app tone.')));
    expect(h.cards[0]).toMatchObject({ title: 'Claude (NOVI) asks: Should I start building per-app tone?', timeoutMs: 120_000, source: 'claude' });
    expect(h.cards[0].question).toEqual({ text: 'Should I start building per-app tone?', options: [{ label: 'Yes, build it' }, { label: 'Not now' }], multiSelect: false });
  });
  it('your answer goes back to Claude, who carries on', async () => {
    const out = await mk().stop(transcript(asked('whats next'), wrapUp(ASK), result(), said('Next.')));
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Yes, build it');
  });
  it('no answer in time or skipped: Claude stops as usual and the app box stays', async () => {
    expect(await mk({ allow: false, timedOut: true }).stop(transcript(asked('x'), wrapUp(ASK), result()))).toEqual({});
    expect(await mk({ allow: false }).stop(transcript(asked('x'), wrapUp(ASK), result()))).toEqual({});
  });
  it('a box with no question is no card', async () => {
    const h = mk();
    expect(await h.stop(transcript(asked('x'), wrapUp({ recap: 'Done.' }), result()))).toEqual({});
    expect(h.cards).toEqual([]);
  });
  it('an old question before your last message is not asked again', async () => {
    const h = mk();
    await h.stop(transcript(asked('a'), wrapUp(ASK), result(), said('Next.'), asked('b'), said('Sure.')));
    expect(h.cards).toEqual([]);
  });
  it('the same question is asked once, even when Claude stops again after your answer', async () => {
    const h = mk();
    const file = transcript(asked('x'), wrapUp(ASK), result());
    await h.stop(file);
    expect(await h.stop(file, { stop_hook_active: true })).toEqual({});
    expect(h.cards).toHaveLength(1);
  });
  it('buttons the app draws by itself still read as words, and a list sent as text is understood', async () => {
    const h = mk();
    await h.stop(transcript(asked('x'), wrapUp({ ask: 'Commit it?', actions: '[{"action":"commit"},{"label":"Not now"}]' }), result()));
    expect(h.cards[0].question.options).toEqual([{ label: 'commit' }, { label: 'Not now' }]);
  });
  it('finished card: held back while a question waits, shown when nobody answers', async () => {
    const answered = mk();
    await answered.stop(transcript(asked('x'), edited(), wrapUp(ASK), result()));
    expect(answered.worked).toEqual([]);
    const silent = mk({ allow: false, timedOut: true });
    await silent.stop(transcript(asked('x'), edited(), wrapUp(ASK), result()));
    expect(silent.worked).toHaveLength(1);
  });
  it("Novi's own tasks and background observers ask nothing", async () => {
    const h = mk();
    await h.stop(transcript(asked('x'), wrapUp(ASK), result()), { novi_task: true });
    expect(h.cards).toEqual([]);
  });
});

describe('the hook script', () => {
  it('waits for an answer on Stop too', () => {
    expect(waitsForAnswer('Stop')).toBe(true);
    expect(waitsForAnswer('PermissionRequest')).toBe(true);
    expect(waitsForAnswer('Notification')).toBe(false);
  });
});
