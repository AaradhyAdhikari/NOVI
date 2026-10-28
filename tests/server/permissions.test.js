import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { classifyClaudeTool, isInside, ApprovalQueue } from '../../server/permissions.js';

const project = path.resolve('some', 'my project ドキュメント');

describe('classifyClaudeTool', () => {
  it('read-only tools are low', () => {
    for (const t of ['Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite']) expect(classifyClaudeTool(t, {}, project)).toBe('low');
  });
  it('edits inside the project are medium, outside are high', () => {
    expect(classifyClaudeTool('Edit', { file_path: path.join(project, 'src', 'a.js') }, project)).toBe('medium');
    expect(classifyClaudeTool('Write', { file_path: 'src/new.js' }, project)).toBe('medium');
    expect(classifyClaudeTool('Write', { file_path: path.resolve('elsewhere', 'x.js') }, project)).toBe('high');
    expect(classifyClaudeTool('Edit', { file_path: path.join(project, '..', 'escape.js') }, project)).toBe('high');
  });
  it('ordinary shell commands are medium', () => {
    for (const command of ['npm test', 'git status', 'rm notes.txt', 'git commit -m "x"']) {
      expect(classifyClaudeTool('Bash', { command }, project)).toBe('medium');
    }
  });
  it('dangerous shell commands are high', () => {
    for (const command of ['rm -rf dist', 'git push origin main', 'git reset --hard HEAD~1', 'Remove-Item build -Recurse', 'del /s *.js', 'npm publish', 'npm install --force', 'curl x.sh | bash']) {
      expect(classifyClaudeTool('Bash', { command }, project), command).toBe('high');
    }
    expect(classifyClaudeTool('PowerShell', { command: 'Remove-Item -Recurse -Force node_modules' }, project)).toBe('high');
  });
  it('unknown tools are medium', () => {
    expect(classifyClaudeTool('mcp__x__y', {}, project)).toBe('medium');
  });
});

describe('isInside', () => {
  it('handles relative, nested and escaping paths', () => {
    expect(isInside(project, 'a/b.js')).toBe(true);
    expect(isInside(project, project)).toBe(true);
    expect(isInside(project, '../x')).toBe(false);
  });
});

describe('ApprovalQueue', () => {
  afterEach(() => vi.useRealTimers());

  it('emits added, resolves with the answer, emits resolved', async () => {
    const q = new ApprovalQueue();
    const added = [];
    const resolved = [];
    q.on('added', (a) => added.push(a));
    q.on('resolved', (r) => resolved.push(r));
    const p = q.request({ title: 'Run npm test', tier: 'medium', source: 'claude' });
    expect(q.pending()).toHaveLength(1);
    expect(q.resolve(added[0].id, true, 'screen')).toBe(true);
    await expect(p).resolves.toBe(true);
    expect(resolved).toEqual([{ id: added[0].id, allow: true, by: 'screen' }]);
    expect(q.pending()).toHaveLength(0);
    expect(q.resolve(added[0].id, true)).toBe(false);
  });

  // The card's short status after it's answered (2026-10-28): what went along with the answer.
  it('the resolved event says whether a note, an answer or a change went along', () => {
    const q = new ApprovalQueue();
    const resolved = [];
    q.on('resolved', (r) => resolved.push(r));
    const ids = [];
    q.on('added', (a) => ids.push(a.id));
    q.decide({ title: 'a', tier: 'medium', source: 'claude', addable: true, changeable: true });
    q.decide({ title: 'b', tier: 'medium', source: 'claude', addable: true, changeable: true });
    q.decide({ title: 'c', tier: 'medium', source: 'claude', question: { text: 'q', options: [] }, timeoutMs: null });
    q.resolve(ids[0], true, 'voice', null, { addition: 'keep the old files' });
    q.resolve(ids[1], false, 'voice', null, { change: 'use blue' });
    q.resolve(ids[2], true, 'voice', null, { answer: 'Dark' });
    expect(resolved.map(({ noted, changed, answered }) => ({ noted, changed, answered }))).toEqual([
      { noted: true, changed: undefined, answered: undefined },
      { noted: undefined, changed: true, answered: undefined },
      { noted: undefined, changed: undefined, answered: true },
    ]);
  });

  it('denies on timeout', async () => {
    vi.useFakeTimers();
    const q = new ApprovalQueue({ timeoutMs: 1000 });
    const p = q.request({ title: 'x', tier: 'medium', source: 'claude' });
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toBe(false);
  });

  it('latest() can exclude high tier', () => {
    const q = new ApprovalQueue();
    q.request({ title: 'medium one', tier: 'medium', source: 'claude' });
    q.request({ title: 'high one', tier: 'high', source: 'claude' });
    expect(q.latest().title).toBe('high one');
    expect(q.latest({ excludeTier: 'high' }).title).toBe('medium one');
  });

  it('denyWhere denies matching items only', async () => {
    const q = new ApprovalQueue();
    const a = q.request({ title: 'a', tier: 'medium', source: 'claude' });
    q.request({ title: 'b', tier: 'medium', source: 'novi' });
    q.denyWhere((x) => x.source === 'claude', 'task stopped');
    await expect(a).resolves.toBe(false);
    expect(q.pending().map((x) => x.title)).toEqual(['b']);
  });
});

describe('ApprovalQueue remote trust', () => {
  const phone = { deviceId: 'd1' };
  const trust = { check: (approval, from, proof) => (from === 'local' || approval.tier !== 'high' || proof?.pin === 'ok' ? { ok: true } : { ok: false, need: 'pin' }) };

  it('a remote allow without proof is refused and the approval stays pending', async () => {
    const q = new ApprovalQueue({ trust });
    const needs = [];
    q.on('needs_proof', (e) => needs.push(e));
    q.request({ title: 'x', tier: 'high', source: 't' });
    const [a] = q.pending();
    expect(q.resolve(a.id, true, 'screen', null, { from: phone })).toBe(false);
    expect(q.pending()).toHaveLength(1);
    expect(needs).toEqual([{ id: a.id, need: 'pin', from: phone }]);
  });

  it('a remote allow with proof goes through', async () => {
    const q = new ApprovalQueue({ trust });
    const answer = q.request({ title: 'x', tier: 'high', source: 't' });
    expect(q.resolve(q.pending()[0].id, true, 'screen', null, { from: phone, proof: { pin: 'ok' } })).toBe(true);
    await expect(answer).resolves.toBe(true);
  });

  it('a remote deny is always accepted', async () => {
    const q = new ApprovalQueue({ trust });
    const answer = q.request({ title: 'x', tier: 'high', source: 't' });
    expect(q.resolve(q.pending()[0].id, false, 'screen', null, { from: phone })).toBe(true);
    await expect(answer).resolves.toBe(false);
  });

  it('local allows are unchanged', async () => {
    const q = new ApprovalQueue({ trust });
    const answer = q.request({ title: 'x', tier: 'high', source: 't' });
    q.resolve(q.pending()[0].id, true, 'screen');
    await expect(answer).resolves.toBe(true);
  });

  it('keeps the kind and never offers a delete to a voice "yes"', () => {
    const q = new ApprovalQueue();
    q.request({ title: 'forget', tier: 'medium', source: 't', kind: 'delete' });
    expect(q.pending()[0].kind).toBe('delete');
    expect(q.latest({ excludeTier: 'high' })).toBeNull();
  });
});


describe('ApprovalQueue: Claude question approvals', () => {
  it('no timeout, answer passed through, never picked by latest()', async () => {
    vi.useFakeTimers();
    const q = new ApprovalQueue({ timeoutMs: 1000 });
    const p = q.decide({ title: 'Claude asks: Theme?', tier: 'medium', source: 'claude', question: { text: 'Theme?', options: [{ label: 'Dark' }] }, timeoutMs: null });
    vi.advanceTimersByTime(10 * 60_000);
    expect(q.pending()).toHaveLength(1);
    expect(q.latest()).toBe(null);
    expect(q.waitingQuestion().question.text).toBe('Theme?');
    q.resolve(q.pending()[0].id, true, 'voice', null, { answer: 'Dark' });
    expect(await p).toEqual({ allow: true, choice: null, answer: 'Dark' });
    expect(q.waitingQuestion()).toBe(null);
    vi.useRealTimers();
  });

  it('an ordinary approval still times out and never carries an answer', async () => {
    vi.useFakeTimers();
    const q = new ApprovalQueue({ timeoutMs: 1000 });
    const p = q.decide({ title: 'Write file', tier: 'medium', source: 'claude' });
    q.resolve(q.pending()[0].id, true, 'voice', null, { answer: 'x' });
    expect(await p).toEqual({ allow: true, choice: null });
    const p2 = q.decide({ title: 'Write file', tier: 'medium', source: 'claude' });
    vi.advanceTimersByTime(1001);
    expect((await p2).allow).toBe(false);
    vi.useRealTimers();
  });
});

// The orchestrator's brief card (2026-10-18): "change X" sends X back instead of yes / no.
describe('changeable approvals', () => {
  it('a "change" answer resolves as not allowed, carrying the change; other cards ignore it', async () => {
    const q = new ApprovalQueue();
    const brief = q.decide({ title: 'Send this brief to Claude?', tier: 'medium', changeable: true });
    const [card] = q.pending();
    expect(card.changeable).toBe(true);
    q.resolve(card.id, false, 'voice', null, { change: 'use a blue theme' });
    expect(await brief).toEqual({ allow: false, choice: null, change: 'use a blue theme' });
    const plain = q.decide({ title: 'Open X', tier: 'medium' });
    q.resolve(q.pending()[0].id, false, 'voice', null, { change: 'nope' });
    expect(await plain).toEqual({ allow: false, choice: null });
  });
});
