import { describe, it, expect } from 'vitest';
import { cardAlert } from '../../server/cardAlerts.js';

// User (2026-10-28): every card pops up on the phone and the laptop, with the short task and buttons;
// PIN cards too ("I will just need to give the PIN"), and tapping opens Novi.
describe('cardAlert', () => {
  it('an ordinary card: the short task, Approve / Deny', () => {
    expect(cardAlert({ id: 'a1', title: 'Claude wants to run: npm test', tier: 'medium', source: 'claude' })).toEqual({
      id: 'a1', title: 'Claude wants to run: npm test', body: 'Tap to open Novi.',
      actions: [{ action: 'approve', title: 'Approve' }, { action: 'deny', title: 'Deny' }],
    });
  });

  it("Claude's question: the question and its first two options", () => {
    const a = cardAlert({ id: 'q1', title: 'Claude asks: Which theme?', tier: 'medium', question: { text: 'Which theme?', options: [{ label: 'Light' }, { label: 'Dark' }, { label: 'Both' }] } });
    expect(a.title).toBe('Claude asks: Which theme?');
    expect(a.body).toBe('Options: Light, Dark, Both. Tap to answer in Novi.');
    expect(a.actions).toEqual([{ action: 'opt:0', title: 'Light' }, { action: 'opt:1', title: 'Dark' }]);
  });

  it('a card with choices: the first two choices', () => {
    const a = cardAlert({ id: 'c1', title: 'Who should build it?', tier: 'medium', choices: [{ id: 'novi-coder', label: 'Novi Coder' }, { id: 'claude', label: 'Claude Code' }] });
    expect(a.actions).toEqual([{ action: 'choice:novi-coder', title: 'Novi Coder' }, { action: 'choice:claude', title: 'Claude Code' }]);
  });

  it('high risk, PIN and delete cards: Approve asks for the PIN in Novi; Deny works from the notification', () => {
    const h = cardAlert({ id: 'h1', title: 'git push', tier: 'high', source: 'claude' });
    expect(h.title).toBe('High risk: git push');
    expect(h.body).toBe('Approving needs your PIN. Tap to open Novi.');
    expect(h.actions).toEqual([{ action: 'approve', title: 'Approve (PIN)' }, { action: 'deny', title: 'Deny' }]);
    expect(cardAlert({ id: 'd1', title: 'Delete the test folder', tier: 'medium', pin: true }).actions[0]).toEqual({ action: 'approve', title: 'Approve (PIN)' });
  });

  it('long titles are cut', () => {
    const a = cardAlert({ id: 'l1', title: `Claude wants to run: ${'x'.repeat(200)}`, tier: 'medium' });
    expect(a.title.length).toBeLessThanOrEqual(90);
    expect(a.title.endsWith('…')).toBe(true);
  });
});
